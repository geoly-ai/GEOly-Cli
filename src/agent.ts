/**
 * Streaming client for the hosted GEO agent (`POST /api/agent/run`, NDJSON).
 *
 * Deliberately separate from McpClient: the agent endpoint is not JSON-RPC and
 * not a tool call — it is one long-lived streaming turn. What it shares with
 * McpClient is the credential path (`ensureAccessToken`, one lazy re-auth on
 * 401) and the HTTP status → GeolyError mapping, so `geoly ask` fails the same
 * way `geoly call` does.
 *
 * The server holds no conversation state; history is sent on every turn.
 */
import { Ctx, autoAuthAllowed } from './context.js';
import { GeolyError } from './errors.js';
import { ensureAccessToken } from './oauth.js';
import { VERSION } from './version.js';

/** No bytes for this long ⇒ the run is considered dead (a tool call can legitimately take ~45s). */
const IDLE_TIMEOUT_MS = 120_000;
/** Outer bound; the server's own route cap is lower (maxDuration 300s). */
const TOTAL_TIMEOUT_MS = 600_000;

export interface AgentTurnInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  brandId?: string;
  locale?: 'zh' | 'en';
}

export type AgentEvent =
  | { type: 'ready'; brand: { id: string; name: string }; model: string; max_steps: number }
  | { type: 'text'; text: string }
  | { type: 'tool'; phase: 'call' | 'result' | 'error'; name: string; message?: string }
  | {
      type: 'done';
      finish_reason: string;
      usage: { input: number; output: number; total: number };
      duration_ms: number;
    }
  | { type: 'error'; message: string };

/** Agent endpoint derived from the configured MCP endpoint (same origin, same allowlist guard). */
function agentUrl(ctx: Ctx): string {
  const url = new URL(ctx.endpoint);
  url.pathname = '/api/agent/run';
  url.search = '';
  if (ctx.org) url.searchParams.set('org_id', ctx.org);
  return url.toString();
}

/** One POST attempt. Returns the response; auth retry is handled by the caller. */
async function postTurn(ctx: Ctx, input: AgentTurnInput, token: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(agentUrl(ctx), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
        authorization: `Bearer ${token}`,
        'x-client-name': 'geoly-cli',
        'x-client-version': VERSION,
      },
      body: JSON.stringify({
        messages: input.messages,
        brand_id: input.brandId,
        locale: input.locale,
      }),
      signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    throw new GeolyError(
      'upstream_unavailable',
      aborted ? 'Agent run timed out' : `Network error: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/** Map a non-2xx agent response onto the CLI's error contract (mirrors mcp.ts). */
async function throwForStatus(res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  let error = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) error = parsed.error;
  } catch {
    // non-JSON body — keep the raw prefix
  }
  if (res.status === 402) {
    throw new GeolyError('subscription_required', 'Subscription is inactive for this organization (HTTP 402)', {
      status: 402,
      hint: 'The hosted agent runs on your plan. Upgrade at https://app.geoly.ai/settings/billing.',
    });
  }
  if (res.status === 403) {
    throw new GeolyError('grant_missing', `Not allowed for this authorization: ${error}`, { status: 403 });
  }
  if (res.status === 404 || res.status === 400) {
    throw new GeolyError('usage_error', error || `Agent rejected the request (HTTP ${res.status})`, {
      status: res.status,
    });
  }
  if (res.status === 429) {
    throw new GeolyError('rate_limited', 'Rate limited (HTTP 429)', { status: 429 });
  }
  throw new GeolyError('upstream_unavailable', `GEOly service error (HTTP ${res.status}): ${error}`, {
    status: res.status,
  });
}

/**
 * Run one turn and yield events as they arrive.
 *
 * The stream is framed as one JSON object per line; a partial trailing line is
 * carried across chunks. Idle and total deadlines both abort the underlying
 * request, so a stalled upstream cannot hang the terminal forever.
 */
export async function* runAgentTurn(ctx: Ctx, input: AgentTurnInput): AsyncGenerator<AgentEvent> {
  let token = await ensureAccessToken(ctx);
  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    let res = await postTurn(ctx, input, token, controller.signal);
    if (res.status === 401) {
      await res.arrayBuffer().catch(() => undefined);
      if (ctx.staticToken || !autoAuthAllowed(ctx)) {
        throw new GeolyError('auth_expired', 'Authentication failed (HTTP 401)', { status: 401 });
      }
      token = await ensureAccessToken(ctx, true); // expired → re-run the browser flow once
      res = await postTurn(ctx, input, token, controller.signal);
    }
    if (!res.ok || !res.body) await throwForStatus(res);

    const decoder = new TextDecoder();
    let buffer = '';
    // Node 18+ web streams are async-iterable at runtime.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      resetIdle();
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          yield JSON.parse(line) as AgentEvent;
        } catch {
          // A malformed line is a server bug, not a reason to kill the turn.
        }
      }
    }
  } catch (err) {
    if (err instanceof GeolyError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new GeolyError(
      'upstream_unavailable',
      aborted ? 'Agent run timed out with no output' : `Agent stream failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}
