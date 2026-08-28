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
  | { type: 'compact'; droppedMessages: number; beforeTokens: number; afterTokens: number }
  | { type: 'text'; text: string }
  | { type: 'tool'; phase: 'call' | 'result' | 'error'; name: string; message?: string; ms?: number }
  | { type: 'done'; steps: number; turnTokens: number; stopped: 'model' | 'budget' | 'interrupted' };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * 上下文预算（本地 loop 的欠账补齐）。
 *
 * 服务端 Sidekick 走 Responses API 的 contextManagement，超阈值自动压缩；本地 loop 走
 * chat/completions 拿不到那套，**必须自己压**——而且也只能自己压：历史在客户端手里，
 * 服务端压了客户端下一轮照样把全量发回去。
 *
 * token 估算用「JSON 字符数 / 4」的粗尺：真实分词要么得引入依赖，要么得多跑一次网络，
 * 而这里只需要判断「是不是快满了」。宁可估高（提前压）也不要估低（顶穿后失败）。
 */
const CHARS_PER_TOKEN = 4;
/** 压缩后至少保留这么多个最近区块，否则「刚查到的东西」会被摘要糊掉。 */
const KEEP_RECENT_BLOCKS = 3;
/**
 * 压缩要一次压到阈值的这个比例以下。
 * 只压到「刚好低于阈值」会抖：下一个工具结果又顶上去，于是每步都压一次，
 * 每次都多花一次计费调用（stub 实测连压 4 次）。留出余量，压一次管很多步。
 */
const COMPACT_TARGET_RATIO = 0.6;

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / CHARS_PER_TOKEN);
}

/**
 * 按「区块」切分消息。一个区块是不可再分的最小单位：
 * 带 tool_calls 的 assistant 连同它全部的 tool 结果算一块，其余消息各自成块。
 *
 * ⚠️ 不能按「对话轮」切：一次深挖问题只有一条 user 消息＝只有一轮，而那恰恰是最容易
 * 撑爆上下文的场景（stub 实测：轮切法在单轮里永远压不了）。按块切才能在一轮内下刀，
 * 同时保证 tool_calls 与 tool 结果不被拆散——拆散会被上游直接拒绝。
 */
function splitBlocks(messages: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  for (const message of messages) {
    const last = blocks[blocks.length - 1];
    if (message.role === 'tool' && last && last[0]?.role === 'assistant' && last[0].tool_calls) {
      last.push(message);
      continue;
    }
    blocks.push([message]);
  }
  return blocks;
}

const COMPACT_INSTRUCTION = [
  'Summarize the earlier part of this GEO analysis conversation so it can replace the raw',
  'messages without losing what matters. Keep, in compact prose or bullets:',
  '- what the user asked and any corrections or preferences they stated',
  '- concrete numbers and findings the tools returned (metric, value, window, brand/platform)',
  '- conclusions already reached, and anything explicitly ruled out',
  'Drop: tool call mechanics, redundant restatements, raw rows already aggregated.',
  'Write it as notes to your future self, not as a reply to the user.',
].join('\n');

/** Tool results go back to the model as text; bound them so one wide query cannot eat the context. */
const MAX_TOOL_RESULT_CHARS = 24_000;

function serializeResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

/**
 * 工具结果的「降级」：完整结果只在它落地后的这么多步里保持原文，之后换成确定性摘要。
 *
 * 一条结果最多 24k 字符（约 6k tokens），一旦进了历史，**后面每一步都要重发一次**。
 * 用模型压缩要额外花一次调用，而且不可预测；这里的降级是纯本地、确定性的：留住形状
 * （行数、前几行、标量字段），丢掉长尾。模型真需要细节时可以重新调那个工具。
 */
const KEEP_FULL_RESULT_STEPS = 2;
const DIGEST_MAX_CHARS = 900;
const DIGEST_SAMPLE_ROWS = 3;
const DIGEST_PREFIX = '[abbreviated earlier tool result]';

/** 数组 → 前几项 + 总数；对象 → 保留标量、数组字段折叠。非 JSON → 截断并标注原长。 */
function digestToolResult(text: string): string {
  if (text.length <= DIGEST_MAX_CHARS) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${DIGEST_PREFIX} ${text.slice(0, DIGEST_MAX_CHARS)}… (${text.length} chars total)`;
  }

  const fold = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const head = value.slice(0, DIGEST_SAMPLE_ROWS).map(fold);
      return value.length > DIGEST_SAMPLE_ROWS
        ? { sample: head, omitted: value.length - DIGEST_SAMPLE_ROWS, total: value.length }
        : head;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fold(v);
      return out;
    }
    return value;
  };

  let folded = JSON.stringify(fold(parsed));
  if (folded.length > DIGEST_MAX_CHARS) folded = `${folded.slice(0, DIGEST_MAX_CHARS)}…`;
  return `${DIGEST_PREFIX} ${folded}`;
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
  /** 防止摘要套摘要：一次压缩进行中时不再触发新的压缩。 */
  private compacting = false;
  /** 每条 tool 消息产生于第几步（用 WeakMap，压缩重建数组后仍然认得同一批对象）。 */
  private toolStep = new WeakMap<ChatMessage, number>();
  private digested = new WeakSet<ChatMessage>();

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

  /**
   * 本轮请求的估算体量：工具面 + 全部历史。工具 schema 每一步都重发，是最大的固定
   * 成分（72 个工具 ≈ 2 万 tokens），漏算它会让压缩迟迟不触发。
   */
  get estimatedTokens(): number {
    return estimateTokens(this.functionTools) + estimateTokens(this.messages);
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
      // 先做零成本的本地降级，再判断要不要花钱压缩——很多时候降级就够了。
      this.demoteStaleResults(step);
      const compacted = await this.compactIfNeeded(signal);
      if (compacted) yield compacted;
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
        this.toolStep.set(toolMessage, step);
        this.messages.push(toolMessage);
        this.append(toolMessage); // transcript 保留原文，降级只影响发给模型的副本
      }
    }

    yield { type: 'done', steps: step, turnTokens, stopped: 'budget' };
  }

  /**
   * 把「已经过了保鲜期」的工具结果就地换成摘要。
   *
   * 零成本、确定性、不改消息结构（tool_call_id 原样保留，配对不受影响）；
   * 落盘的 transcript 仍是原文，只有发给模型的副本被瘦身。
   */
  private demoteStaleResults(currentStep: number): void {
    for (const message of this.messages) {
      if (message.role !== 'tool' || this.digested.has(message)) continue;
      const born = this.toolStep.get(message);
      if (born === undefined || currentStep - born <= KEEP_FULL_RESULT_STEPS) continue;
      const text = message.content ?? '';
      const digest = digestToolResult(text);
      if (digest.length >= text.length) {
        this.digested.add(message);
        continue;
      }
      message.content = digest;
      this.digested.add(message);
    }
  }

  /**
   * 超阈值就把早期对话压成一段摘要。
   *
   * 只在轮边界下刀，且永远保留最近 KEEP_RECENT_TURNS 轮原文；摘要本身要多花一次
   * 计费调用，所以只在真的超了才做，压完还超也不再连压（避免摘要套摘要的死循环）。
   * 阈值来自服务端 profile（同一个 GEO_AGENT_COMPACT_THRESHOLD），0 = 关闭。
   */
  private async compactIfNeeded(
    signal?: AbortSignal,
  ): Promise<Extract<LoopEvent, { type: 'compact' }> | undefined> {
    const threshold = this.profile.compact_threshold ?? 0;
    if (threshold <= 0 || this.compacting) return undefined;
    const before = this.estimatedTokens;
    if (before <= threshold) return undefined;

    const [system, ...rest] = this.messages;
    const blocks = splitBlocks(rest);

    // 必须留下的：当前正在回答的问题（否则模型忘了自己在干什么）+ 最近若干块（刚查到的
    // 事实原文）。其余按原顺序压成一段摘要 —— 注意问题块常常是第 0 块，所以「保留集」
    // 不能表达成一个前缀区间，否则单轮深挖场景永远找不到下刀点（stub 实测）。
    let lastUserBlock = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.[0]?.role === 'user') {
        lastUserBlock = i;
        break;
      }
    }
    // 保留块数从 KEEP_RECENT_BLOCKS 起，一路收紧到「留下的部分低于目标线」为止，
    // 但至少留 1 块最近的（以及当前问题）。
    const target = threshold * COMPACT_TARGET_RATIO;
    const buildKeep = (recent: number): Set<number> => {
      const set = new Set<number>();
      if (lastUserBlock >= 0) set.add(lastUserBlock);
      for (let i = Math.max(0, blocks.length - recent); i < blocks.length; i++) set.add(i);
      return set;
    };
    let keep = buildKeep(KEEP_RECENT_BLOCKS);
    for (let recent = KEEP_RECENT_BLOCKS; recent > 1; recent--) {
      keep = buildKeep(recent);
      const keptTokens =
        estimateTokens(this.functionTools) +
        estimateTokens([...(system ? [system] : []), ...blocks.filter((_, i) => keep.has(i)).flat()]);
      if (keptTokens <= target) break;
    }
    const staleIndexes = blocks.map((_, i) => i).filter((i) => !keep.has(i));
    if (staleIndexes.length < 2) return undefined; // 可丢弃的历史不足，压了不划算

    const firstStale = staleIndexes[0] as number;
    const stale = staleIndexes.flatMap((i) => blocks[i] ?? []);

    this.compacting = true;
    let summary = '';
    try {
      // 摘要调用不带工具：它只需要读，不需要再查。
      for await (const chunk of streamCompletion(
        this.ctx,
        {
          messages: [
            { role: 'system', content: COMPACT_INSTRUCTION },
            { role: 'user', content: JSON.stringify(stale) },
          ],
        },
        signal,
      )) {
        if (chunk.type === 'text') summary += chunk.text;
      }
    } catch {
      // 压缩失败不该杀掉这一轮：继续用原历史发出去，顶多是上游报上下文超限。
      this.compacting = false;
      return undefined;
    }
    this.compacting = false;
    if (!summary.trim()) return undefined;

    const digest: ChatMessage = {
      role: 'user',
      content: `[Earlier conversation, compacted]\n${summary.trim()}`,
    };
    // 摘要插在第一块被丢弃的位置上，保持「问题 → 早期工作摘要 → 最近工作」的时间顺序。
    const rebuilt: ChatMessage[] = system ? [system] : [];
    blocks.forEach((block, i) => {
      if (i === firstStale) rebuilt.push(digest);
      if (keep.has(i)) rebuilt.push(...block);
    });
    this.messages = rebuilt;
    this.append({ role: 'user', content: '[compacted]' });
    return {
      type: 'compact',
      droppedMessages: stale.length,
      beforeTokens: before,
      afterTokens: this.estimatedTokens,
    };
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
