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

/** Write tools are blocked in v0 (contract §9). trigger_prompt also consumes credits. */
export const WRITE_TOOLS = new Set(['create_prompt', 'create_topic', 'create_competitor', 'trigger_prompt']);

export type ToolAccess = 'read-only' | 'write' | 'credit-consuming';

export function toolAccess(name: string): ToolAccess {
  if (name === 'trigger_prompt') return 'credit-consuming';
  return WRITE_TOOLS.has(name) ? 'write' : 'read-only';
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
            ? 'GEOLY_TOKEN was rejected — regenerate it in the GEOly dashboard.'
            : 'Run `geoly auth login`, or set GEOLY_TOKEN for CI.',
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
        throw new GeolyError('tool_error', rpc.error.message || 'Tool call failed', {
          tool: opts.tool,
          cause: rpc.error,
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

  /** tools/call for one tool. Write tools are blocked client-side in v0. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (WRITE_TOOLS.has(name)) {
      throw new GeolyError('write_blocked', `Tool "${name}" performs writes — blocked in this CLI version`, {
        tool: name,
        hint: 'Write support ships in a later release. Use the GEOly web app or the remote MCP with a write grant.',
      });
    }
    return this.request<ToolCallResult>('tools/call', { name, arguments: args }, { tool: name });
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

/** Parse a JSON or SSE-framed JSON-RPC response body. */
async function parseRpcBody(res: Response, tool?: string): Promise<JsonRpcResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  try {
    if (contentType.includes('text/event-stream')) {
      // Frames are separated by blank lines; each frame's data: lines hold JSON.
      for (const frame of text.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        const msg = JSON.parse(data) as JsonRpcResponse;
        if (msg && ('result' in msg || 'error' in msg)) return msg;
      }
      throw new Error('no JSON-RPC response frame in event stream');
    }
    return JSON.parse(text) as JsonRpcResponse;
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
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  if (result.isError) {
    throw new GeolyError('tool_error', text || `Tool "${name}" returned an error`, { tool: name });
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
