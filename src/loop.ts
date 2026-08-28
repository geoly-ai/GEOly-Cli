/**
 * The agent session — the loop runs on your machine.
 *
 * This is the shape the mainstream agent workers use (Claude Code, Codex,
 * opencode): the loop, the tools and the state are local; only inference is
 * remote. For GEOly that split means the data tools stay server-side (they read
 * the warehouse, over MCP — already shipped) while everything that makes an
 * agent a *worker* — memory, transcripts, resumability, visible steps — lives
 * here, where the filesystem and the process are free.
 *
 * A session holds the profile, the tool surface and the conversation, so an
 * interactive run pays for setup once and every turn after that is just
 * `run(question)`. One step = one metered completion.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentProfile, ToolCall, fetchProfile, streamCompletion } from './agent.js';
import { GEOLY_DIR, ensureDir } from './config.js';
import { Ctx } from './context.js';
import { GeolyError } from './errors.js';
import { McpClient, ToolInfo, WRITE_TOOLS, unwrapToolResult } from './mcp.js';
import { applyRemember, memoryBlock, readNotes } from './memory.js';

/** Client-side tool: the agent's own memory. Not an MCP tool — it writes to your disk. */
const REMEMBER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'remember',
    description:
      'Keep a short note for future sessions with this brand, or update/remove one. ' +
      'Notes live in a local markdown file the user can edit. Same slug overwrites. ' +
      'You decide what is worth keeping — durable facts, corrections the user made, ' +
      'conclusions you would otherwise re-derive. Do not store transient query results.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short stable id, kebab-case, e.g. "main-competitors"' },
        content: { type: 'string', description: 'The note itself. Omit when removing.' },
        remove: { type: 'boolean', description: 'Delete the note with this slug.' },
      },
      required: ['slug'],
    },
  },
};

export type LoopEvent =
  | { type: 'step'; n: number }
  | { type: 'text'; text: string }
  | { type: 'tool'; phase: 'call' | 'result' | 'error'; name: string; message?: string; ms?: number }
  | { type: 'done'; steps: number; turnTokens: number; stopped: 'model' | 'budget' | 'interrupted' };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Tool results go back to the model as text; bound them so one wide query cannot eat the context. */
const MAX_TOOL_RESULT_CHARS = 24_000;

function serializeResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

/** MCP tool descriptors → OpenAI function tools. Write tools are dropped: this CLI is read-only. */
function toFunctionTools(tools: ToolInfo[]): unknown[] {
  return [
    ...tools
      .filter((t) => !WRITE_TOOLS.has(t.name))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        },
      })),
    REMEMBER_TOOL,
  ];
}

/** `~/.geoly/sessions/<id>.jsonl` — one JSON message per line, appended as the turn progresses. */
function transcriptPath(id: string): string {
  return path.join(GEOLY_DIR, 'sessions', `${id}.jsonl`);
}

/** Most recent transcript for a brand, or undefined when there is none. */
export function findLatestSession(brandId: string): string | undefined {
  const dir = path.join(GEOLY_DIR, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const mine = entries
    .filter((f) => f.endsWith('.jsonl') && f.includes(brandId.replace(/[^a-zA-Z0-9._-]/g, '_')))
    .sort();
  return mine[mine.length - 1]?.replace(/\.jsonl$/, '');
}

export class AgentSession {
  private constructor(
    private readonly ctx: Ctx,
    private readonly client: McpClient,
    readonly profile: AgentProfile,
    private readonly functionTools: unknown[],
    private messages: ChatMessage[],
    readonly id: string,
  ) {}

  /**
   * Set the session up once: profile and tool list are independent round-trips,
   * so they are fetched together, and memory is folded into the system prompt
   * at creation rather than on every turn.
   */
  static async create(
    ctx: Ctx,
    opts: { brandId?: string; locale?: 'zh' | 'en'; resume?: boolean } = {},
  ): Promise<AgentSession> {
    const client = new McpClient(ctx);
    const [profile, tools] = await Promise.all([
      fetchProfile(ctx, { brandId: opts.brandId, locale: opts.locale }),
      client.listTools(),
    ]);

    // 系统提示每次都用**当前**的 profile + 记忆重建，不从 transcript 里恢复：
    // 续跑时用户可能刚手改过记忆文件，旧提示会把改动吞掉。transcript 只存对话。
    const system: ChatMessage = {
      role: 'system',
      content: profile.system_prompt + memoryBlock(profile.brand.id),
    };
    // 续跑目标只能在拿到 profile 之后才知道（品牌由服务端解析），所以 --continue
    // 不需要用户先说 --brand；找不到历史就静默开新会话，而不是让用户吃一个错误。
    const resumeId = opts.resume ? findLatestSession(profile.brand.id) : undefined;
    let messages: ChatMessage[];
    let id: string;
    const restored = resumeId ? loadTranscript(resumeId) : undefined;
    if (resumeId && restored) {
      messages = [system, ...restored.filter((m) => m.role !== 'system')];
      id = resumeId;
    } else {
      messages = [system];
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      id = `${stamp}-${profile.brand.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    }

    return new AgentSession(ctx, client, profile, toFunctionTools(tools), messages, id);
  }

  /** Tool count as the model sees it (MCP read tools + the local `remember`). */
  get toolCount(): number {
    return this.functionTools.length;
  }

  /** Notes currently injected into this session's system prompt. */
  get memoryCount(): number {
    return readNotes(this.profile.brand.id).length;
  }

  /** Turns exchanged so far (user messages). */
  get turnCount(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  /** Drop the conversation, keep profile/tools/memory. Starts a new transcript. */
  reset(): void {
    const system = this.messages[0];
    this.messages = system ? [system] : [];
  }

  /**
   * Run one question to completion.
   *
   * Aborting (Ctrl-C) stops the model stream immediately; an in-flight tool call
   * still finishes, because the MCP client owns its own request deadline. The
   * conversation is left consistent either way: a turn that is interrupted after
   * tool calls keeps its tool results, so the next turn can build on them.
   */
  async *run(question: string, signal?: AbortSignal): AsyncGenerator<LoopEvent> {
    this.messages.push({ role: 'user', content: question });
    this.append({ role: 'user', content: question });

    let turnTokens = 0;
    let step = 0;
    while (step < this.profile.max_steps) {
      if (signal?.aborted) {
        yield { type: 'done', steps: step, turnTokens, stopped: 'interrupted' };
        return;
      }
      step += 1;
      yield { type: 'step', n: step };

      const assistantText: string[] = [];
      let calls: ToolCall[] = [];
      for await (const chunk of streamCompletion(
        this.ctx,
        { messages: this.messages, tools: this.functionTools },
        signal,
      )) {
        if (chunk.type === 'text') {
          assistantText.push(chunk.text);
          yield { type: 'text', text: chunk.text };
        } else if (chunk.type === 'tool_calls') {
          calls = chunk.calls;
        } else if (chunk.type === 'finish') {
          turnTokens += chunk.totalTokens;
        }
      }

      if (calls.length === 0) {
        const answer: ChatMessage = { role: 'assistant', content: assistantText.join('') };
        this.messages.push(answer);
        this.append(answer);
        yield { type: 'done', steps: step, turnTokens, stopped: 'model' };
        return;
      }

      const assistant: ChatMessage = {
        role: 'assistant',
        content: assistantText.join('') || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      };
      this.messages.push(assistant);
      this.append(assistant);

      // Calls within one step are independent — run them together, report in order.
      for (const call of calls) yield { type: 'tool', phase: 'call', name: call.name };
      const startedAt = Date.now();
      const results = await Promise.all(calls.map((call) => this.executeCall(call)));
      const ms = Date.now() - startedAt;
      for (const [i, call] of calls.entries()) {
        const result = results[i];
        if (!result) continue;
        yield result.failed
          ? { type: 'tool', phase: 'error', name: call.name, message: result.text.slice(0, 200), ms }
          : { type: 'tool', phase: 'result', name: call.name, ms };
        const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content: result.text };
        this.messages.push(toolMessage);
        this.append(toolMessage);
      }
    }

    yield { type: 'done', steps: step, turnTokens, stopped: 'budget' };
  }

  /**
   * Execute one tool call. `remember` is handled locally; everything else goes
   * to MCP. Failures come back as text rather than thrown — a failed call is
   * information the agent can act on, not a reason to kill the run.
   */
  private async executeCall(call: ToolCall): Promise<{ text: string; failed: boolean }> {
    let args: Record<string, unknown>;
    try {
      args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch {
      return { text: `error: arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, failed: true };
    }
    if (call.name === 'remember') {
      return {
        text: applyRemember(this.profile.brand.id, args as { slug?: string; content?: string; remove?: boolean }),
        failed: false,
      };
    }
    try {
      const result = await this.client.callTool(call.name, args);
      return { text: serializeResult(unwrapToolResult(call.name, result)), failed: false };
    } catch (err) {
      const message = err instanceof GeolyError ? err.message : (err as Error).message;
      return { text: `error: ${message}`, failed: true };
    }
  }

  /** Append one message to the transcript. Persistence must never break a run. */
  private append(message: ChatMessage): void {
    try {
      ensureDir();
      const file = transcriptPath(this.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf8');
    } catch {
      // a read-only home directory should not end the session
    }
  }
}

/** Read a transcript back into messages. Corrupt lines are skipped, not fatal. */
function loadTranscript(id: string): ChatMessage[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath(id), 'utf8');
  } catch {
    return undefined;
  }
  const messages: ChatMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as ChatMessage);
    } catch {
      // skip
    }
  }
  return messages.length > 0 ? messages : undefined;
}
