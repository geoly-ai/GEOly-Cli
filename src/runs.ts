/**
 * Client for the hosted Agent API (`/api/agent/runs`) — what `geoly run` and `geoly runs` speak.
 *
 * The server runs the whole agent loop and bills it; this file only knows how to start a run,
 * follow its SSE stream, and read it back later. Two facts of the server contract shape
 * everything here:
 *   - a run keeps going after the client disconnects and lands in the run log, so giving up on
 *     the stream is never giving up on the answer — `GET /runs/:id` picks it up;
 *   - the same command re-sent within 10 minutes with the same `Idempotency-Key` replays the
 *     existing run (JSON, not SSE) instead of starting and charging a second one.
 */
import * as crypto from 'node:crypto';
import { apiUrl, authedFetch, throwForStatus } from './agent.js';
import { Ctx } from './context.js';
import { GeolyError } from './errors.js';

export interface RunRequest {
  question: string;
  brandId?: string;
  spec?: string;
  context?: string;
  maxCredits?: number;
  /**
   * Let the hosted agent call GEOly write tools this run (server `allow_writes`). The server still
   * checks the token's consent Write grant per resource; without it the run is read-only.
   */
  allowWrites?: boolean;
}

/** One SSE event as the server names them (`started`, `step`, `tool`, `text`, `done`, …). */
export interface RunEvent {
  event: string;
  data: Record<string, unknown>;
}

export type RunOutcome =
  /** The `done` event: the server's receipt (run_id, answer, credits, deliverable…). */
  | { kind: 'done'; payload: Record<string, unknown> }
  /** The `error` event: the run itself failed on the server. */
  | { kind: 'failed'; runId?: string; code: string; message: string }
  /** Still going on the server; we stopped following (wait budget, Ctrl-C, or a dropped stream). */
  | { kind: 'running'; runId: string; elapsedS: number }
  /** Idempotent replay of an earlier run (the server answered with JSON instead of a stream). */
  | { kind: 'replayed'; record: Record<string, unknown> };

/** Heartbeats arrive every 10s; three misses in a row means the connection is gone. */
const STREAM_IDLE_TIMEOUT_MS = 35_000;

/**
 * Stable key for "this exact command": every input that changes what the server would do is in it
 * (org, brand, spec, question, context, spend cap, write permission). Lowering `--max-credits` on
 * a re-run is a new command — it must not replay the run that is still going with the higher cap;
 * so is adding `--allow-writes` to a question that ran read-only.
 */
export function idempotencyKeyFor(ctx: Ctx, req: RunRequest): string {
  const material = JSON.stringify([
    ctx.org ?? '',
    req.brandId ?? '',
    req.spec ?? '',
    req.question,
    req.context ?? '',
    req.maxCredits ?? '',
    req.allowWrites ? 'writes' : '',
  ]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

/** Server run rows say `succeeded`; the CLI says `done` everywhere (streams already do). */
export function normalizeStatus(status: unknown): string {
  return status === 'succeeded' ? 'done' : typeof status === 'string' ? status : 'unknown';
}

/**
 * Start a run and follow it for at most `waitMs`. Resolves with the outcome — never rejects
 * just because the stream stopped early, as long as a run id was seen (the run lives on).
 */
export async function startRun(
  ctx: Ctx,
  req: RunRequest,
  opts: { waitMs: number; idempotencyKey?: string; signal?: AbortSignal; onEvent?: (e: RunEvent) => void },
): Promise<RunOutcome> {
  const body: Record<string, unknown> = { question: req.question };
  if (ctx.org) body.org_id = ctx.org;
  if (req.brandId) body.brand_id = req.brandId;
  if (req.spec) body.spec = req.spec;
  if (req.context) body.context = req.context;
  if (req.maxCredits !== undefined) body.max_credits = req.maxCredits;
  if (req.allowWrites) body.allow_writes = true;

  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });

  // `--timeout` = headers deadline (see authedFetch); the stream itself is bounded by `--wait`.
  const res = await authedFetch(
    ctx,
    apiUrl(ctx, '/api/agent/runs'),
    { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal },
    { ms: ctx.timeoutMs, abort },
  );
  if (!res.ok) await throwForStatus(res);

  // Replay: the server short-circuited to JSON (see Idempotency-Key in the route contract).
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const record = (await res.json()) as Record<string, unknown>;
    return { kind: 'replayed', record };
  }
  if (!res.body) throw new GeolyError('upstream_unavailable', 'Empty response from the agent API');

  let runId: string | undefined;
  // Wait budget: stop following (the run continues) once it is spent. `--no-wait` (0) must NOT
  // arm a timer — a 0ms timer fires before the first body chunk arrives and we would abort before
  // ever seeing `started` (review #2); it returns as soon as the run id is known instead.
  // A huge budget effectively means "until it finishes".
  const budget = opts.waitMs > 0 ? setTimeout(abort, opts.waitMs) : undefined;
  try {
    for await (const ev of readSse(res.body, controller.signal)) {
      opts.onEvent?.(ev);
      if (ev.event === 'started' && typeof ev.data.run_id === 'string') {
        runId = ev.data.run_id;
        if (opts.waitMs <= 0) abort();
      } else if (ev.event === 'done') {
        return { kind: 'done', payload: ev.data };
      } else if (ev.event === 'error') {
        return {
          kind: 'failed',
          runId,
          code: typeof ev.data.code === 'string' ? ev.data.code : 'RUN_FAILED',
          message: typeof ev.data.message === 'string' ? ev.data.message : 'run failed',
        };
      }
    }
  } catch (err) {
    // Aborted by us (budget / Ctrl-C) or the connection dropped: both are "still running" if
    // we know which run — that is the contract that makes the hand-off safe.
    if (!runId) {
      if (controller.signal.aborted) {
        throw new GeolyError('upstream_unavailable', 'The run was interrupted before the server acknowledged it', {
          hint: 'Check `geoly runs list` — if a run started, it will be there.',
        });
      }
      throw new GeolyError('upstream_unavailable', `Stream error: ${(err as Error).message}`, { cause: err });
    }
  } finally {
    if (budget) clearTimeout(budget);
    opts.signal?.removeEventListener('abort', abort);
    // Whatever way we leave — done, hand-off, idle timeout, Ctrl-C — release the connection.
    // A half-open socket keeps the event loop alive and the command would print its receipt
    // and then never exit (review #3). Aborting after `done` is harmless: the server is finished.
    abort();
  }
  if (!runId) {
    throw new GeolyError('upstream_unavailable', 'The stream ended without a run id or a result', {
      hint: 'Check `geoly runs list` — if a run started, it will be there.',
    });
  }
  return { kind: 'running', runId, elapsedS: Math.round((Date.now() - startedAt) / 1000) };
}

/** `GET /api/agent/runs/:id` — the run log row (answer included once finished). */
export async function getRun(ctx: Ctx, runId: string): Promise<Record<string, unknown>> {
  const res = await authedFetch(ctx, apiUrl(ctx, `/api/agent/runs/${encodeURIComponent(runId)}`), {
    method: 'GET',
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  if (res.status === 404) {
    throw new GeolyError('usage_error', `No run "${runId}" visible to this token`, {
      hint: 'Run ids look like run_…; `geoly runs list` shows recent ones.',
    });
  }
  if (!res.ok) await throwForStatus(res);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Poll a run until it leaves `running` or the wait budget is spent. Each poll is one cheap
 * GET; the interval is generous because runs take tens of seconds per step anyway.
 */
export async function waitRun(
  ctx: Ctx,
  runId: string,
  opts: { waitMs: number; intervalMs: number; signal?: AbortSignal; onPoll?: (record: Record<string, unknown>) => void },
): Promise<RunOutcome> {
  const startedAt = Date.now();
  for (;;) {
    const record = await getRun(ctx, runId);
    opts.onPoll?.(record);
    const status = normalizeStatus(record.status);
    if (status === 'done') return { kind: 'done', payload: record };
    if (status === 'failed') {
      return { kind: 'failed', runId, code: 'RUN_FAILED', message: String(record.error ?? 'run failed') };
    }
    const elapsed = Date.now() - startedAt;
    if (opts.signal?.aborted || elapsed + opts.intervalMs > opts.waitMs) {
      return { kind: 'running', runId, elapsedS: Math.round(elapsed / 1000) };
    }
    await sleepUnlessAborted(opts.intervalMs, opts.signal);
    if (opts.signal?.aborted) return { kind: 'running', runId, elapsedS: Math.round((Date.now() - startedAt) / 1000) };
  }
}

/** Sleep that ends early on abort; removes its own listener so a long poll does not pile them up (review #7). */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `GET /api/agent/runs` — recent runs for the org (receipt fields only). */
export async function listRuns(ctx: Ctx, opts: { brandId?: string; limit?: number }): Promise<unknown> {
  const res = await authedFetch(
    ctx,
    apiUrl(ctx, '/api/agent/runs', { brand_id: opts.brandId, limit: opts.limit ? String(opts.limit) : undefined }),
    { method: 'GET', signal: AbortSignal.timeout(ctx.timeoutMs) },
  );
  if (!res.ok) await throwForStatus(res);
  return res.json();
}

/**
 * Minimal SSE reader: frames are blank-line separated, `event:` names the frame, `data:` lines
 * carry JSON. Yields parsed frames; throws on idle timeout (no bytes at all, heartbeats included).
 */
async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // One idle watchdog for the whole stream, re-armed on every chunk and torn down on exit.
  // (A fresh timer per read was never cleared: a finished `geoly run` lingered up to 35s before
  // the process could exit, and >10 chunks tripped MaxListenersExceededWarning — review #1.)
  let idleTimer: NodeJS.Timeout | undefined;
  let rejectIdle: ((e: Error) => void) | undefined;
  const idle = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  idle.catch(() => undefined); // consumed via Promise.race; never let it surface as unhandled
  const arm = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => rejectIdle?.(new Error('no data from the server for 35s')), STREAM_IDLE_TIMEOUT_MS);
  };
  const onAbort = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      arm();
      const { value, done } = await Promise.race([reader.read(), idle]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal.removeEventListener('abort', onAbort);
    // Give the body back and cancel it — otherwise the socket stays open behind the lock.
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(frame: string): RunEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (event === 'heartbeat') return { event, data: {} };
  if (!data.length) return undefined;
  try {
    const parsed = JSON.parse(data.join('')) as unknown;
    return { event, data: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
  } catch {
    return undefined;
  }
}
