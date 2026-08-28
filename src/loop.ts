/**
 * The agent loop — runs on your machine.
 *
 * This is the shape the mainstream agent workers use (Claude Code, Codex,
 * opencode): the loop, the tools, and the state live locally; only inference is
 * remote. For GEOly that split means the data tools stay server-side (they read
 * the warehouse, over MCP — already shipped) while everything that makes an
 * agent a *worker* — memory, artifacts, resumability, visible steps — can grow
 * here, where the filesystem and the process are free.
 *
 * One step = one metered completion. Tool calls are executed locally and fed
 * back as tool messages until the model stops asking for tools or the step
 * budget runs out.
 */
import { Ctx } from './context.js';
import { GeolyError } from './errors.js';
import { McpClient, ToolInfo, WRITE_TOOLS, unwrapToolResult } from './mcp.js';
import { applyRemember, memoryBlock } from './memory.js';
import { AgentProfile, ToolCall, fetchProfile, streamCompletion } from './agent.js';

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
  | { type: 'ready'; profile: AgentProfile; toolCount: number; memoryNotes: number }
  | { type: 'step'; n: number }
  | { type: 'text'; text: string }
  | { type: 'tool'; phase: 'call' | 'result' | 'error'; name: string; message?: string }
  | { type: 'done'; steps: number; totalTokens: number; stopped: 'model' | 'budget' };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** MCP tool descriptors → OpenAI function tools. Write tools are dropped: this CLI is read-only. */
function toFunctionTools(tools: ToolInfo[]): unknown[] {
  const usable = tools.filter((t) => !WRITE_TOOLS.has(t.name));
  return [
    ...usable.map((t) => ({
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

/** Tool results go back to the model as text; keep them bounded so one wide query cannot eat the context. */
const MAX_TOOL_RESULT_CHARS = 24_000;

function serializeResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

/**
 * Execute one tool call. `remember` is handled locally; everything else goes to
 * MCP. Tool failures are returned to the model as text rather than thrown — a
 * failed call is information the agent can act on, not a reason to kill the run.
 */
async function executeCall(
  client: McpClient,
  brandId: string,
  call: ToolCall,
): Promise<{ text: string; failed: boolean }> {
  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return { text: `error: arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, failed: true };
  }

  if (call.name === 'remember') {
    return { text: applyRemember(brandId, args as { slug?: string; content?: string; remove?: boolean }), failed: false };
  }

  try {
    const result = await client.callTool(call.name, args);
    return { text: serializeResult(unwrapToolResult(call.name, result)), failed: false };
  } catch (err) {
    const message = err instanceof GeolyError ? err.message : (err as Error).message;
    return { text: `error: ${message}`, failed: true };
  }
}

/**
 * Run one question to completion.
 *
 * History is caller-owned: pass `history` to continue a conversation. The server
 * stores nothing, so what you keep is what the agent remembers within a session;
 * across sessions it is the memory file that carries over.
 */
export async function* runLoop(
  ctx: Ctx,
  input: {
    question: string;
    brandId?: string;
    locale?: 'zh' | 'en';
    history?: ChatMessage[];
  },
): AsyncGenerator<LoopEvent> {
  const client = new McpClient(ctx);
  // Profile and tool list are independent round-trips — do not serialize them.
  const [profile, tools] = await Promise.all([
    fetchProfile(ctx, { brandId: input.brandId, locale: input.locale }),
    client.listTools(),
  ]);

  const memory = memoryBlock(profile.brand.id);
  const functionTools = toFunctionTools(tools);
  const messages: ChatMessage[] = input.history?.length
    ? [...input.history]
    : [{ role: 'system', content: profile.system_prompt + memory }];
  messages.push({ role: 'user', content: input.question });

  yield {
    type: 'ready',
    profile,
    toolCount: functionTools.length,
    memoryNotes: memory ? memory.split('\n### ').length - 1 : 0,
  };

  let totalTokens = 0;
  let step = 0;
  while (step < profile.max_steps) {
    step += 1;
    yield { type: 'step', n: step };

    const assistantText: string[] = [];
    let calls: ToolCall[] = [];
    for await (const chunk of streamCompletion(ctx, { messages, tools: functionTools })) {
      if (chunk.type === 'text') {
        assistantText.push(chunk.text);
        yield { type: 'text', text: chunk.text };
      } else if (chunk.type === 'tool_calls') {
        calls = chunk.calls;
      } else if (chunk.type === 'finish') {
        totalTokens += chunk.totalTokens;
      }
    }

    if (calls.length === 0) {
      yield { type: 'done', steps: step, totalTokens, stopped: 'model' };
      return;
    }

    messages.push({
      role: 'assistant',
      content: assistantText.join('') || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    // Calls within one step are independent — run them together, keep result order.
    for (const call of calls) yield { type: 'tool', phase: 'call', name: call.name };
    const results = await Promise.all(calls.map((call) => executeCall(client, profile.brand.id, call)));
    for (const [i, call] of calls.entries()) {
      const result = results[i];
      if (!result) continue;
      yield result.failed
        ? { type: 'tool', phase: 'error', name: call.name, message: result.text.slice(0, 200) }
        : { type: 'tool', phase: 'result', name: call.name };
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }

  yield { type: 'done', steps: step, totalTokens, stopped: 'budget' };
}
