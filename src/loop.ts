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
import { FETCH_TOOL, fetchPage } from './fetcher.js';
import { applyRemember, memoryBlock, readNotes } from './memory.js';
import {
  CORE_TOOL_NAMES,
  type CatalogEntry,
  FIND_TOOLS_TOOL,
  TOOL_LOAD_LIMIT,
  canLoadMore,
  searchCatalog,
} from './tool-catalog.js';
import { WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, Workspace, type PlanItem, type WriteApproval } from './workspace.js';

/** Client-side tool: the agent's own memory. Not an MCP tool — it writes to your disk. */
const REMEMBER_TOOL = {
  type: 'function' as const,
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
};

export type LoopEvent =
  | { type: 'step'; n: number }
  | { type: 'compact'; droppedMessages: number; beforeTokens: number; afterTokens: number }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'tools_loaded'; names: string[] }
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      phase: 'call' | 'result' | 'error';
      name: string;
      /** `call` only: the arguments, shortened for one line (`time_range: "30d", platform: "chatgpt"`) */
      args?: string;
      /** `result` only: size of what came back, so a 40s call that returned 2 bytes is visible as such */
      bytes?: number;
      message?: string;
      ms?: number;
    }
  | { type: 'done'; steps: number; turnTokens: number; stopped: 'model' | 'budget' | 'interrupted' };

/**
 * One-line preview of a tool call's arguments for the terminal: `k: v, k2: v2`, strings quoted,
 * long values elided, whole thing capped. Never throws — malformed JSON just shows as-is, cut.
 */
export function previewArgs(raw: string, max = 72): string {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const parts = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
    const value =
      typeof v === 'string'
        ? JSON.stringify(v.length > 32 ? `${v.slice(0, 31)}…` : v)
        : typeof v === 'number' || typeof v === 'boolean' || v === null
          ? String(v)
          : Array.isArray(v)
            ? `[${v.length}]`
            : '{…}';
    return `${k}: ${value}`;
  });
  const joined = parts.join(', ');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

/**
 * Responses 输入项。三种形态：
 * - 对话消息 `{role, content}`（system 不在此列——它走 instructions）
 * - 模型发起的调用 `{type:'function_call', call_id, name, arguments}`
 * - 我们回灌的结果 `{type:'function_call_output', call_id, output}`
 */
export interface InputItem {
  type?: 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant';
  content?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
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
function splitBlocks(messages: InputItem[]): InputItem[][] {
  const blocks: InputItem[][] = [];
  for (const message of messages) {
    const last = blocks[blocks.length - 1];
    // function_call_output 必须紧跟它的 function_call，同块不可拆
    if (message.type === 'function_call_output' && last && last[0]?.type === 'function_call') {
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
/**
 * 装配这一步要发给模型的工具面：本地工具 + `find_tools` + **当前激活的** MCP 工具。
 *
 * 不再全量下发（见 tool-catalog.ts）：常驻集由真实用量决定，其余按需搜出来。
 */
function toFunctionTools(tools: ToolInfo[], active: Set<string>): unknown[] {
  // Responses 的函数工具是**扁平**结构（name/description/parameters 直接在顶层），
  // 不是 chat completions 的 { type:'function', function:{...} } 包装。
  return [
    ...tools
      .filter((t) => !WRITE_TOOLS.has(t.name) && active.has(t.name))
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    FIND_TOOLS_TOOL,
    REMEMBER_TOOL,
    // harness：本地工具与 MCP 数据工具同处一个工具面，模型不需要知道谁在哪边执行。
    ...WORKSPACE_TOOLS,
    // 服务端把 fetch_page 排除在 MCP 之外（其它客户端自带联网），CLI 自己补上：
    // 本地抓取免费、无往返，且「不执行 JS 的纯 HTTP 视角」正是 GEO 要看的东西。
    FETCH_TOOL,
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
  private toolStep = new WeakMap<InputItem, number>();
  private digested = new WeakSet<InputItem>();
  /** 本会话额外装载的 MCP 工具数（受 TOOL_LOAD_LIMIT 约束）。 */
  private loadedCount = 0;
  /** 最近一次 find_tools 命中的名字，供 UI 呈现。 */
  private lastLoaded: string[] = [];

  private constructor(
    private readonly ctx: Ctx,
    private readonly client: McpClient,
    readonly profile: AgentProfile,
    /** 系统提示 + 记忆，走 Responses 的 instructions 而非输入项。 */
    private readonly instructions: string,
    /** MCP 侧全部可用工具（含未激活的），供 find_tools 检索。 */
    private readonly catalog: ToolInfo[],
    /** 当前激活的 MCP 工具名——决定这一步发给模型的工具面。 */
    private readonly active: Set<string>,
    private messages: InputItem[],
    readonly id: string,
    readonly workspace: Workspace,
  ) {}

  /**
   * Set the session up once: profile and tool list are independent round-trips,
   * so they are fetched together, and memory is folded into the system prompt
   * at creation rather than on every turn.
   */
  static async create(
    ctx: Ctx,
    opts: {
      brandId?: string;
      locale?: 'zh' | 'en';
      resume?: boolean;
      workspaceRoot?: string;
      approveWrite?: WriteApproval;
    } = {},
  ): Promise<AgentSession> {
    const client = new McpClient(ctx);
    const [profile, tools] = await Promise.all([
      fetchProfile(ctx, { brandId: opts.brandId, locale: opts.locale }),
      client.listTools(),
    ]);

    // 系统提示每次都用**当前**的 profile + 记忆重建，不从 transcript 恢复：
    // 续跑时用户可能刚手改过记忆文件，旧提示会把改动吞掉。transcript 只存对话。
    // Responses 把它放在 instructions，不占输入项——顺带让压缩少一个特例。
    const instructions = profile.system_prompt + memoryBlock(profile.brand.id);
    // 续跑目标只能在拿到 profile 之后才知道（品牌由服务端解析），所以 --continue
    // 不需要用户先说 --brand；找不到历史就静默开新会话，而不是让用户吃一个错误。
    const resumeId = opts.resume ? findLatestSession(profile.brand.id) : undefined;
    const restored = resumeId ? loadTranscript(resumeId) : undefined;
    const messages: InputItem[] = restored ?? [];
    const id =
      resumeId && restored
        ? resumeId
        : `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${profile.brand.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // 默认工作区=启动目录：agent 产出的东西落在用户此刻所在的地方，符合终端直觉。
    // 没给审批回调时一律拒绝写入（脚本场景必须显式 --allow-writes）。
    const workspace = new Workspace(
      opts.workspaceRoot ?? process.cwd(),
      opts.approveWrite ?? (async () => false),
    );
    return new AgentSession(
      ctx,
      client,
      profile,
      instructions,
      tools.filter((t) => !WRITE_TOOLS.has(t.name)),
      new Set(
        tools.filter((t) => CORE_TOOL_NAMES.has(t.name)).map((t) => t.name)
      ),
      messages,
      id,
      workspace
    );
  }

  /** 这一步实际发给模型的工具面（本地工具 + find_tools + 已激活的 MCP 工具）。 */
  private get functionTools(): unknown[] {
    return toFunctionTools(this.catalog, this.active);
  }

  /** Tool count as the model sees it. */
  get toolCount(): number {
    return this.functionTools.length;
  }

  /** MCP 侧总共有多少工具可达（含尚未激活的）。 */
  get catalogSize(): number {
    return this.catalog.length;
  }

  /**
   * 本轮请求的估算体量：工具面 + 全部历史。工具 schema 每一步都重发，是最大的固定
   * 成分（72 个工具 ≈ 2 万 tokens），漏算它会让压缩迟迟不触发。
   */
  get estimatedTokens(): number {
    return (
      estimateTokens(this.functionTools) +
      estimateTokens(this.instructions) +
      estimateTokens(this.messages)
    );
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
        {
          brandId: this.profile.brand.id,
          instructions: this.instructions,
          input: this.messages,
          tools: this.functionTools,
        },
        signal,
      )) {
        if (chunk.type === 'text') {
          assistantText.push(chunk.text);
          yield { type: 'text', text: chunk.text };
        } else if (chunk.type === 'tool_calls') {
          calls = chunk.calls;
        } else if (chunk.type === 'web_search') {
          // 模型自带的联网检索：对用户来说和别的工具没区别，用同一种呈现。
          yield {
            type: 'tool',
            phase: chunk.phase === 'start' ? 'call' : 'result',
            name: 'web_search',
          };
        } else if (chunk.type === 'finish') {
          turnTokens += chunk.totalTokens;
        }
      }

      if (calls.length === 0) {
        const answer: InputItem = { role: 'assistant', content: assistantText.join('') };
        this.messages.push(answer);
        this.append(answer);
        yield { type: 'done', steps: step, turnTokens, stopped: 'model' };
        return;
      }

      // Responses：助手正文与每个调用是**各自独立的输入项**，不是一条消息里挂 tool_calls。
      const text = assistantText.join('');
      if (text) {
        const said: InputItem = { role: 'assistant', content: text };
        this.messages.push(said);
        this.append(said);
      }
      for (const call of calls) {
        const item: InputItem = {
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
        this.messages.push(item);
        this.append(item);
      }

      // Calls within one step are independent — run them together, report in order.
      for (const call of calls) yield { type: 'tool', phase: 'call', name: call.name, args: previewArgs(call.arguments) };
      const startedAt = Date.now();
      const results = await Promise.all(calls.map((call) => this.executeCall(call)));
      const ms = Date.now() - startedAt;
      for (const [i, call] of calls.entries()) {
        const result = results[i];
        if (!result) continue;
        yield result.failed
          ? { type: 'tool', phase: 'error', name: call.name, message: result.text.slice(0, 200), ms }
          : { type: 'tool', phase: 'result', name: call.name, ms, bytes: Buffer.byteLength(result.text, 'utf8') };
        if (call.name === 'update_plan' && !result.failed) {
          yield { type: 'plan', items: this.workspace.currentPlan };
        }
        if (call.name === 'find_tools' && this.lastLoaded.length > 0) {
          yield { type: 'tools_loaded', names: this.lastLoaded };
          this.lastLoaded = [];
        }
        const toolMessage: InputItem = {
          type: 'function_call_output',
          call_id: call.id,
          output: result.text,
        };
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
      if (message.type !== 'function_call_output' || this.digested.has(message)) continue;
      const born = this.toolStep.get(message);
      if (born === undefined || currentStep - born <= KEEP_FULL_RESULT_STEPS) continue;
      const text = message.output ?? '';
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

    // 输入项里已经没有系统提示（它在 instructions），全部参与切块，不再有前缀特例。
    const blocks = splitBlocks(this.messages);

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
        estimateTokens(this.instructions) +
        estimateTokens(blocks.filter((_, i) => keep.has(i)).flat());
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
          brandId: this.profile.brand.id,
          instructions: COMPACT_INSTRUCTION,
          input: [{ role: 'user', content: JSON.stringify(stale) }],
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

    const digest: InputItem = {
      role: 'user',
      content: `[Earlier conversation, compacted]\n${summary.trim()}`,
    };
    // 摘要插在第一块被丢弃的位置上，保持「问题 → 早期工作摘要 → 最近工作」的时间顺序。
    const rebuilt: InputItem[] = [];
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
   * 按需把工具装进工具面。
   *
   * 命中即激活——不做「先看再单独加载」的两段式：那要多一个回合，而模型搜之前就已经
   * 知道自己想干什么了。返回值只给名字与一句话描述，完整 schema 由下一步的工具面承载。
   */
  private findTools(query: string): string {
    if (!query.trim()) return 'error: query is required';
    const catalog: CatalogEntry[] = this.catalog.map((t) => ({
      name: t.name,
      description: t.description ?? '',
    }));
    const matches = searchCatalog(catalog, query, this.active);
    if (matches.length === 0) {
      return `no unloaded tool matches "${query}". The tools already in your list may be the right ones.`;
    }
    const room = TOOL_LOAD_LIMIT - this.loadedCount;
    if (room <= 0) {
      return `tool budget is full (${TOOL_LOAD_LIMIT} extra tools loaded this session); work with what you have.`;
    }
    const taken = matches.slice(0, room);
    for (const m of taken) {
      this.active.add(m.name);
      this.loadedCount += 1;
    }
    this.lastLoaded = taken.map((m) => m.name);
    return taken
      .map((m) => `${m.name} — ${m.description.slice(0, 200)}`)
      .join('\n');
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
    if (WORKSPACE_TOOL_NAMES.has(call.name)) {
      switch (call.name) {
        case 'write_file':
          return { text: await this.workspace.write(args), failed: false };
        case 'read_file':
          return { text: this.workspace.read(args), failed: false };
        case 'list_files':
          return { text: this.workspace.list(args), failed: false };
        default:
          return { text: this.workspace.updatePlan(args), failed: false };
      }
    }
    if (call.name === 'find_tools') {
      return {
        text: this.findTools(String((args as { query?: unknown }).query ?? '')),
        failed: false,
      };
    }
    if (call.name === 'fetch_page') {
      const page = await fetchPage(String((args as { url?: unknown }).url ?? ''));
      return 'error' in page
        ? { text: `error: ${page.error}`, failed: true }
        : { text: serializeResult(page), failed: false };
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
  private append(message: InputItem): void {
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
function loadTranscript(id: string): InputItem[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath(id), 'utf8');
  } catch {
    return undefined;
  }
  const messages: InputItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as InputItem);
    } catch {
      // skip
    }
  }
  return messages.length > 0 ? messages : undefined;
}
