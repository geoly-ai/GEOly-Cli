/**
 * Minimal MCP client for the GEOly endpoint.
 *
 * The server is verified stateless streamable-HTTP: POST-only (GET/DELETE
 * return 405), no session ids, each JSON-RPC request is self-contained and the
 * response body is either application/json or a short text/event-stream. A
 * hand-rolled client (~150 lines) beats the SDK here because we need full
 * access to HTTP status codes and headers (401 challenge, 429 Retry-After,
 * 402 subscription) to honor the CLI's error contract.
 */
import { ToolsCacheFile, cachePath, readJson, writeJson } from './config.js';
import { Ctx, autoAuthAllowed } from './context.js';
import { GeolyError } from './errors.js';
import { ensureAccessToken, parseRetryAfter, sleep } from './oauth.js';
import { warn } from './output.js';
import { MCP_PROTOCOL_VERSION, VERSION } from './version.js';

const TOOLS_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_BUDGET_MS = 60_000;
/** Server error codes (from the metering wrapper's JSON tail) that mean "wait, then the same call works". */
const RATE_LIMIT_CODES = new Set(['GUARDED_RATE_LIMITED', 'CIRCUIT_OPEN']);

/** All text blocks of a tool result joined — what a human would read. */
function resultText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/**
 * The server's error results are "headline line + one JSON line" (metering contract §F):
 * `{ error: 'GUARDED_RATE_LIMITED', tool, retry_after_seconds, ... }`. Pull that JSON out
 * when present so the CLI can map it onto its own error kinds instead of showing prose.
 */
export function structuredErrorTail(
  result: ToolCallResult,
): { error: string; retryAfter?: number; payload: Record<string, unknown> } | undefined {
  const lines = resultText(result).trim().split('\n');
  const last = lines[lines.length - 1]?.trim();
  if (!last?.startsWith('{')) return undefined;
  try {
    const payload = JSON.parse(last) as Record<string, unknown>;
    if (typeof payload.error !== 'string') return undefined;
    const ra = payload.retry_after_seconds;
    return { error: payload.error, retryAfter: typeof ra === 'number' && ra > 0 ? ra : undefined, payload };
  } catch {
    return undefined;
  }
}

/**
 * Server write tools — mirror of geoly-app `MCP_STANDARD_WRITE_TOOLS` (src/lib/geo-agent/tools.ts);
 * change both together. The server only registers them for a token whose consent screen
 * granted Write on the resource, and never for an all-organizations grant. The CLI never
 * calls one without an explicit go-ahead (contract §9): `geoly call … --yes` or an
 * interactive [y/N], `--allow-writes` or an interactive approval in an agent session.
 * trigger_prompt additionally consumes monitoring credits.
 */
export const WRITE_TOOLS = new Set([
  'create_prompt',
  'create_topic',
  'create_competitor',
  'trigger_prompt',
  'archive_prompt',
  'update_prompt_tags',
  'move_prompts_to_topic',
]);

/** Consent-screen resource each write tool needs (for the "re-login and tick Write" hint). */
export const WRITE_TOOL_RESOURCE: Record<string, string> = {
  create_prompt: 'prompt',
  archive_prompt: 'prompt',
  update_prompt_tags: 'prompt',
  move_prompts_to_topic: 'prompt',
  create_topic: 'topic',
  create_competitor: 'competitor',
  trigger_prompt: 'monitoring trigger',
};

export type ToolAccess = 'read-only' | 'write' | 'credit-consuming';

export function toolAccess(name: string): ToolAccess {
  if (name === 'trigger_prompt') return 'credit-consuming';
  return WRITE_TOOLS.has(name) ? 'write' : 'read-only';
}

/**
 * Why a write tool is not in this token's tool list. The server registers write tools
 * per consent grant, so "unknown tool" for a known write name means "not granted here".
 */
export function writeGrantHint(name: string, ctx: Ctx): string {
  const resource = WRITE_TOOL_RESOURCE[name] ?? 'that resource';
  if (ctx.staticToken) {
    return `GEOLY_TOKEN tokens are read-only. Unset it and run \`geoly auth login\`, then tick Write › ${resource} on the consent screen.`;
  }
  return (
    `This authorization has no Write grant for ${resource}. Run \`geoly auth login\` again, ` +
    `choose ONE organization (an all-organizations grant is read-only) and tick Write › ${resource} on the consent screen, then retry.`
  );
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  title?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

let rpcId = 0;

export class McpClient {
  constructor(private readonly ctx: Ctx) {}

  /** Endpoint URL with the optional --org narrowing applied. */
  private url(): string {
    if (!this.ctx.org) return this.ctx.endpoint;
    const u = new URL(this.ctx.endpoint);
    u.searchParams.set('org_id', this.ctx.org);
    return u.toString();
  }

  /**
   * Send one JSON-RPC request. Handles: lazy auth on 401 (one retry after a
   * fresh browser flow), Retry-After-honoring 429 back-off, 402/403/5xx
   * mapping, and SSE response bodies.
   */
  async request<T>(method: string, params: unknown, opts: { tool?: string } = {}): Promise<T> {
    let token = await ensureAccessToken(this.ctx);
    let authRetried = false;
    let attempts = 0;
    const budgetEnd = Date.now() + RATE_LIMIT_BUDGET_MS;

    for (;;) {
      attempts += 1;
      let res: Response;
      const id = ++rpcId;
      try {
        res = await fetch(this.url(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'x-client-name': 'geoly-cli',
            'x-client-version': VERSION,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(this.ctx.timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        throw new GeolyError(
          'upstream_unavailable',
          timedOut ? `Request timed out after ${this.ctx.timeoutMs / 1000}s` : `Network error: ${(err as Error).message}`,
          { tool: opts.tool, cause: err },
        );
      }

      if (res.status === 401) {
        await res.arrayBuffer().catch(() => undefined);
        if (!authRetried && !this.ctx.staticToken && autoAuthAllowed(this.ctx)) {
          authRetried = true;
          token = await ensureAccessToken(this.ctx, true); // token expired → re-run browser flow
          continue;
        }
        throw new GeolyError('auth_expired', 'Authentication failed (HTTP 401)', {
          status: 401,
          tool: opts.tool,
          hint: this.ctx.staticToken
            ? 'GEOLY_TOKEN was rejected — legacy tokens can no longer be created; unset it and run `geoly auth login` instead.'
            : 'Run `geoly auth login` (use --no-browser on headless machines).',
        });
      }
      if (res.status === 402) {
        await res.arrayBuffer().catch(() => undefined);
        throw new GeolyError('subscription_required', 'Subscription is inactive for this organization (HTTP 402)', {
          status: 402,
          tool: opts.tool,
          hint: 'Renew the plan at https://www.geoly.ai — then retry.',
        });
      }
      if (res.status === 403) {
        await res.arrayBuffer().catch(() => undefined);
        throw new GeolyError('grant_missing', 'This authorization does not grant access to the requested resource (HTTP 403)', {
          status: 403,
          tool: opts.tool,
          hint: 'Re-run `geoly auth login` and approve the needed permissions on the consent screen.',
        });
      }
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after')) ?? 2 ** attempts;
        await res.arrayBuffer().catch(() => undefined);
        const waitMs = retryAfter * 1000;
        if (attempts < RATE_LIMIT_MAX_ATTEMPTS && Date.now() + waitMs < budgetEnd) {
          warn(`geoly: rate limited — retrying in ${retryAfter}s (${attempts}/${RATE_LIMIT_MAX_ATTEMPTS})`);
          await sleep(waitMs);
          continue;
        }
        throw new GeolyError('rate_limited', 'Rate limited and retry budget exhausted (HTTP 429)', {
          status: 429,
          retryAfter,
          tool: opts.tool,
        });
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        throw new GeolyError('upstream_unavailable', `GEOly service error (HTTP ${res.status})`, {
          status: res.status,
          tool: opts.tool,
          hint: 'Transient — a short back-off then retry is reasonable.',
        });
      }

      const rpc = await parseRpcBody(res, opts.tool);
      if (rpc.error) {
        // -32602 = the server's schema validation rejected the arguments before anything ran:
        // that is the caller's mistake (usage, exit 2), not a tool failure (exit 1). Agents
        // branch on this to fix the call instead of retrying or blaming the service.
        const invalidParams = rpc.error.code === -32602;
        throw new GeolyError(invalidParams ? 'usage_error' : 'tool_error', rpc.error.message || 'Tool call failed', {
          tool: opts.tool,
          cause: rpc.error,
          hint: invalidParams ? `Check the parameters with: geoly schema ${opts.tool ?? '<tool>'}` : undefined,
        });
      }
      return rpc.result as T;
    }
  }

  /** tools/list with the 60s cache and stale-on-network-failure fallback. */
  async listTools(refresh = false): Promise<ToolInfo[]> {
    const file = cachePath(this.ctx.profile);
    const cached = readJson<ToolsCacheFile>(file);
    const cacheValid =
      cached &&
      cached.endpoint === this.url() &&
      Date.now() - cached.fetchedAt < TOOLS_CACHE_TTL_MS;
    if (cacheValid && !refresh) return cached!.tools as ToolInfo[];

    try {
      const result = await this.request<{ tools: ToolInfo[] }>('tools/list', {});
      const tools = result.tools ?? [];
      writeJson(file, { endpoint: this.url(), fetchedAt: Date.now(), tools } satisfies ToolsCacheFile);
      return tools;
    } catch (err) {
      // Network/upstream trouble: fall back to a stale cache so agents keep working.
      if (cached && cached.endpoint === this.url() && err instanceof GeolyError && err.kind === 'upstream_unavailable') {
        warn('geoly: could not refresh the tool list — using a stale cache');
        return cached.tools as ToolInfo[];
      }
      throw err;
    }
  }

  /**
   * tools/call for one tool. A write tool needs an explicit go-ahead from the caller
   * (`writeApproved`) — the CLI never mutates data on the strength of a flag it inferred.
   *
   * The server never rate-limits a tool call at the HTTP layer (its metering contract is
   * "never break the connection"): a per-organization guard shows up as an `isError` result
   * with `retry_after_seconds` in its JSON tail. Honor it once, inside the same call budget,
   * so a script does not have to know about the in-band shape. Timeouts are not retried
   * here — the server asks for ~60s and the result is cached when it lands, so that is the
   * caller's decision.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { writeApproved?: boolean } = {},
  ): Promise<ToolCallResult> {
    if (WRITE_TOOLS.has(name) && !opts.writeApproved) {
      throw new GeolyError('write_blocked', `Tool "${name}" modifies data — confirmation required`, {
        tool: name,
        hint:
          name === 'trigger_prompt'
            ? 'It also spends monitoring credits. Re-run with --yes to confirm, or answer the prompt in a terminal.'
            : 'Re-run with --yes to confirm (scripts), or answer the prompt in a terminal.',
      });
    }
    const result = await this.request<ToolCallResult>('tools/call', { name, arguments: args }, { tool: name });
    const tail = result.isError ? structuredErrorTail(result) : undefined;
    if (tail && RATE_LIMIT_CODES.has(tail.error) && tail.retryAfter !== undefined) {
      const waitMs = tail.retryAfter * 1000;
      if (waitMs <= RATE_LIMIT_BUDGET_MS) {
        warn(`geoly: ${name} is rate limited by the server — retrying once in ${tail.retryAfter}s`);
        await sleep(waitMs);
        return this.request<ToolCallResult>('tools/call', { name, arguments: args }, { tool: name });
      }
    }
    return result;
  }

  /** initialize — used by whoami to read server info/instructions. */
  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string }; instructions?: string }> {
    return this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'geoly-cli', version: VERSION },
    });
  }
}

/** The JSON-RPC response frame inside one SSE frame, if it holds one. */
function rpcFrame(frame: string): JsonRpcResponse | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  if (!data) return undefined;
  const msg = JSON.parse(data) as JsonRpcResponse;
  return msg && ('result' in msg || 'error' in msg) ? msg : undefined;
}

/**
 * Parse a JSON or SSE-framed JSON-RPC response body.
 *
 * The SSE branch is incremental on purpose: it resolves on the first frame that carries a
 * JSON-RPC result and cancels the rest. Reading the body to EOF (`res.text()`) made the CLI
 * hostage to whoever closes the stream — twice in 2026-09 a tool finished server-side in
 * ~19s (mcp_call_log says success) while the stream stayed open behind the proxy and the
 * CLI sat there until its own timeout. The answer was already on the wire; take it.
 */
async function parseRpcBody(res: Response, tool?: string): Promise<JsonRpcResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  try {
    if (!contentType.includes('text/event-stream')) {
      return JSON.parse(await res.text()) as JsonRpcResponse;
    }
    if (!res.body) throw new Error('empty event stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      // Frames are separated by blank lines; keep the (possibly partial) last one in the buffer.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : (frames.pop() ?? '');
      for (const frame of frames) {
        const msg = rpcFrame(frame);
        if (msg) {
          if (!done) reader.cancel().catch(() => undefined);
          return msg;
        }
      }
      if (done) {
        const tail = buffer ? rpcFrame(buffer) : undefined;
        if (tail) return tail;
        throw new Error('no JSON-RPC response frame in event stream');
      }
    }
  } catch (err) {
    throw new GeolyError('upstream_unavailable', 'Could not parse the server response', { tool, cause: err });
  }
}

/**
 * Unwrap a tool result for printing: prefer structuredContent, else parse the
 * single text block as JSON, else return the raw text. isError becomes a
 * tool_error with the server's message.
 */
export function unwrapToolResult(name: string, result: ToolCallResult): unknown {
  const text = resultText(result);
  if (result.isError) {
    const tail = structuredErrorTail(result);
    const headline = (text.split('\n')[0] ?? '').trim() || `Tool "${name}" returned an error`;
    if (tail && RATE_LIMIT_CODES.has(tail.error)) {
      throw new GeolyError('rate_limited', headline, { tool: name, retryAfter: tail.retryAfter, cause: tail.payload });
    }
    if (tail?.error === 'TOOL_TIMEOUT') {
      throw new GeolyError('upstream_unavailable', headline, {
        tool: name,
        retryAfter: tail.retryAfter,
        cause: tail.payload,
        hint: 'Narrow the window / scope, or retry the same call once after ~60s (heavy queries keep running and are cached).',
      });
    }
    throw new GeolyError('tool_error', text || headline, { tool: name, cause: tail?.payload });
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}
