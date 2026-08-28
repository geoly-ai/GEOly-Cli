/**
 * HTTP layer for the local agent worker.
 *
 * The loop runs on your machine (see loop.ts); the server keeps only two things:
 * `/api/agent/profile` — the system prompt and step budget, so the methodology
 * can change without a CLI release — and `/api/agent/completions` — a metered
 * proxy that runs inference on GEOly's key and bills it to your org.
 *
 * Credentials and error mapping are shared with McpClient so `geoly ask` fails
 * the same way `geoly call` does.
 */
import { Ctx, autoAuthAllowed } from './context.js';
import { GeolyError } from './errors.js';
import { ensureAccessToken } from './oauth.js';
import { VERSION } from './version.js';

/** No bytes from the model for this long ⇒ the step is dead. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface AgentProfile {
  brand: { id: string; name: string };
  model: string;
  max_steps: number;
  system_prompt: string;
  /** Compact the conversation past this many estimated tokens. 0/absent = never. */
  compact_threshold?: number;
}

/** One assembled tool call from the model. */
export interface ToolCall {
  /** Responses `call_id` — what a function_call_output must be addressed to. */
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model; parsed by the caller so it can report bad JSON. */
  arguments: string;
}

export type CompletionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  /** The model ran its own web search (a server-side built-in, not one of our tools). */
  | { type: 'web_search'; phase: 'start' | 'done' }
  | { type: 'finish'; reason: string; totalTokens: number };

/** Same-origin sibling of the configured MCP endpoint (endpoint allowlist already applied). */
function apiUrl(ctx: Ctx, pathname: string, params?: Record<string, string | undefined>): string {
  const url = new URL(ctx.endpoint);
  url.pathname = pathname;
  url.search = '';
  if (ctx.org) url.searchParams.set('org_id', ctx.org);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

function headers(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-client-name': 'geoly-cli',
    'x-client-version': VERSION,
  };
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
      hint: 'Hosted inference runs on your plan: https://app.geoly.ai/settings/billing',
    });
  }
  if (res.status === 403) {
    throw new GeolyError('grant_missing', `Not allowed for this authorization: ${error}`, { status: 403 });
  }
  if (res.status === 429) {
    throw new GeolyError('rate_limited', `Daily model budget reached for this organization (${error})`, {
      status: 429,
    });
  }
  if (res.status === 400 || res.status === 404 || res.status === 413) {
    throw new GeolyError('usage_error', error || `Rejected (HTTP ${res.status})`, { status: res.status });
  }
  throw new GeolyError('upstream_unavailable', `GEOly service error (HTTP ${res.status}): ${error}`, {
    status: res.status,
  });
}

/** Fetch with one lazy re-auth on 401, matching McpClient's behavior. */
async function authedFetch(ctx: Ctx, url: string, init: RequestInit): Promise<Response> {
  let token = await ensureAccessToken(ctx);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: headers(token) });
  } catch (err) {
    throw new GeolyError('upstream_unavailable', `Network error: ${(err as Error).message}`, { cause: err });
  }
  if (res.status === 401) {
    await res.arrayBuffer().catch(() => undefined);
    if (ctx.staticToken || !autoAuthAllowed(ctx)) {
      throw new GeolyError('auth_expired', 'Authentication failed (HTTP 401)', { status: 401 });
    }
    token = await ensureAccessToken(ctx, true);
    try {
      res = await fetch(url, { ...init, headers: headers(token) });
    } catch (err) {
      throw new GeolyError('upstream_unavailable', `Network error: ${(err as Error).message}`, { cause: err });
    }
  }
  return res;
}

/** The server-held half of the agent: system prompt, step budget, resolved brand. */
export async function fetchProfile(
  ctx: Ctx,
  opts: { brandId?: string; locale?: 'zh' | 'en' } = {},
): Promise<AgentProfile> {
  const res = await authedFetch(
    ctx,
    apiUrl(ctx, '/api/agent/profile', { brand_id: opts.brandId, locale: opts.locale }),
    { method: 'GET', signal: AbortSignal.timeout(ctx.timeoutMs) },
  );
  if (!res.ok) await throwForStatus(res);
  return (await res.json()) as AgentProfile;
}

/**
 * Stream one model step through the metered proxy (Responses API).
 *
 * Why Responses rather than chat completions: on our gateway it is the only path
 * that carries the model's built-in web search and that reports `cached_tokens`
 * at all — with chat completions, any request carrying tools reported zero cache
 * hits. Both were measured, not assumed.
 *
 * The event stream is typed rather than positional: text arrives as
 * `response.output_text.delta`, tool calls are assembled from
 * `response.output_item.added` + `response.function_call_arguments.*`, and usage
 * rides on the final `response.completed`.
 */
export async function* streamCompletion(
  ctx: Ctx,
  body: { instructions?: string; input: unknown[]; tools?: unknown[] },
  signal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let idle = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);

  try {
    const res = await authedFetch(ctx, apiUrl(ctx, '/api/agent/completions'), {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) await throwForStatus(res);

    const decoder = new TextDecoder();
    let tail = '';
    let totalTokens = 0;
    let finishReason = 'stop';
    /** Assembled by output_index, because arguments stream in fragments. */
    const calls = new Map<number, ToolCall>();

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
      tail += decoder.decode(chunk, { stream: true });
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: ResponseEvent;
        try {
          ev = JSON.parse(payload) as ResponseEvent;
        } catch {
          continue; // heartbeat / comment line
        }

        switch (ev.type) {
          case 'response.output_text.delta':
            if (ev.delta) yield { type: 'text', text: ev.delta };
            break;
          case 'response.output_item.added':
            if (ev.item?.type === 'function_call') {
              calls.set(ev.output_index ?? calls.size, {
                id: ev.item.call_id ?? ev.item.id ?? '',
                name: ev.item.name ?? '',
                arguments: ev.item.arguments ?? '',
              });
            }
            break;
          case 'response.function_call_arguments.delta': {
            const current = calls.get(ev.output_index ?? 0);
            if (current && ev.delta) current.arguments += ev.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const current = calls.get(ev.output_index ?? 0);
            // done 携带完整参数：以它为准，避免分片拼接漏尾
            if (current && typeof ev.arguments === 'string') current.arguments = ev.arguments;
            break;
          }
          case 'response.web_search_call.in_progress':
            yield { type: 'web_search', phase: 'start' };
            break;
          case 'response.web_search_call.completed':
            yield { type: 'web_search', phase: 'done' };
            break;
          case 'response.completed':
          case 'response.incomplete':
            totalTokens = ev.response?.usage?.total_tokens ?? 0;
            finishReason = ev.type === 'response.incomplete' ? 'incomplete' : 'stop';
            break;
          case 'response.failed':
            throw new GeolyError(
              'upstream_unavailable',
              `Model run failed: ${ev.response?.error?.message ?? 'unknown error'}`,
            );
          default:
            break;
        }
      }
    }

    if (calls.size > 0) {
      const assembled = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)
        .filter((c) => c.name && c.id);
      if (assembled.length > 0) yield { type: 'tool_calls', calls: assembled };
    }
    yield { type: 'finish', reason: finishReason, totalTokens };
  } catch (err) {
    if (err instanceof GeolyError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new GeolyError(
      'upstream_unavailable',
      aborted ? 'Model stream stalled with no output' : `Model stream failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Only the event fields this client acts on; everything else is ignored by design. */
interface ResponseEvent {
  type: string;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: { usage?: { total_tokens?: number }; error?: { message?: string } };
}
