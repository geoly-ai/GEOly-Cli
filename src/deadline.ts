/**
 * Client-side deadlines, and the one error shape for "our own deadline ran out".
 *
 * Why this exists: `geoly call` used to give every tool a fixed 30 s, while the server lets its
 * heavy tools run for up to 45–50 s before answering with a proper `TOOL_TIMEOUT` (hint +
 * `retry_after_seconds`). The client gave up first. Worse, the server sends SSE headers at once,
 * so the timer usually fired *while the body was being read* — the aborted read then surfaced
 * as "Could not parse the server response" (`upstream_unavailable`), hiding both the fact that
 * it was our timeout and the server's own hint. Production acceptance hit exactly that on
 * `get_competitor_polarity` and `get_risk_context_sources`.
 *
 * The fix has two halves:
 *  1. derive each tool call's deadline from the server's advertised budget
 *     (`tools/list` → `_meta["geoly/timeoutMs"]`) plus a grace period, so the server's own
 *     timeout answer always arrives first;
 *  2. classify any abort caused by our deadline — before headers or mid-body — as kind
 *     `timeout`, never as a parse failure.
 */
import type { Ctx } from './context.js';
import { MAX_TIMEOUT_S } from './context.js';
import { GeolyError } from './errors.js';

/** `tools/list` metadata key carrying a tool's server-side time budget in milliseconds. */
export const TOOL_BUDGET_META_KEY = 'geoly/timeoutMs';
/** Headroom on top of the server budget: response serialization, proxy hops, TLS, a cold pool. */
export const SERVER_BUDGET_GRACE_MS = 15_000;
/** A tool call whose budget the server does not advertise (older server, unknown tool). */
export const CALL_DEFAULT_TIMEOUT_MS = 60_000;

/** The tool's advertised server-side budget, if the server sent a sane one. */
export function advertisedBudgetMs(tool: { _meta?: unknown } | undefined): number | undefined {
  const meta = tool?._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const raw = (meta as Record<string, unknown>)[TOOL_BUDGET_META_KEY];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * The deadline for one `tools/call`.
 *
 * - server advertises a budget B: `max(--timeout, B + 15 s)` — an explicit `--timeout` can
 *   lengthen the wait but never cut it below the server's budget, because that is exactly the
 *   window in which the server's own (actionable) timeout answer would have arrived;
 * - no advertised budget: `--timeout` when given, else 60 s.
 *
 * The derived value is capped at the `--timeout` maximum so a bogus server value cannot make
 * the CLI hang for an hour.
 */
export function toolDeadlineMs(ctx: Pick<Ctx, 'timeoutOverrideMs'>, budgetMs: number | undefined): number {
  const override = ctx.timeoutOverrideMs;
  if (budgetMs === undefined) return override ?? CALL_DEFAULT_TIMEOUT_MS;
  const derived = Math.min(budgetMs + SERVER_BUDGET_GRACE_MS, MAX_TIMEOUT_S * 1000);
  return override !== undefined ? Math.max(override, derived) : derived;
}

/** A running deadline: an AbortSignal plus a flag that says whether *our timer* fired. */
export interface Deadline {
  readonly signal: AbortSignal;
  readonly ms: number;
  /** True once the timer fired — the only reliable way to tell our abort from anyone else's. */
  fired(): boolean;
  clear(): void;
}

/** Arm a deadline. Always `clear()` it (try/finally) so a finished request leaves no timer behind. */
export function startDeadline(ms: number): Deadline {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new DOMException(`deadline of ${ms}ms exceeded`, 'TimeoutError'));
  }, ms);
  return {
    signal: controller.signal,
    ms,
    fired: () => fired,
    clear: () => clearTimeout(timer),
  };
}

/** Whether a thrown value is an abort (fetch / body read / AbortSignal.timeout), in any runtime's spelling. */
export function isAbortError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth += 1) {
    const name = (e as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The client-timeout error. `what` names the request ("get_brand_overview", "tools/list",
 * "GET /api/agent/runs/…") so the message says what was waited on.
 */
export function clientTimeoutError(opts: {
  deadlineMs: number;
  serverBudgetMs?: number;
  tool?: string;
  what?: string;
  cause?: unknown;
  hint?: string;
  retryable?: boolean;
}): GeolyError {
  const seconds = fmtSeconds(opts.deadlineMs);
  const subject = opts.what ?? opts.tool;
  const budget =
    opts.serverBudgetMs !== undefined ? ` (this tool may take up to ${fmtSeconds(opts.serverBudgetMs)}s server-side)` : '';
  return new GeolyError(
    'timeout',
    `No response${subject ? ` from ${subject}` : ''} within ${seconds}s${budget}. The server may still be working; retry once, or raise --timeout.`,
    {
      tool: opts.tool,
      cause: opts.cause,
      deadlineMs: opts.deadlineMs,
      serverBudgetMs: opts.serverBudgetMs,
      retryable: opts.retryable,
      hint:
        opts.hint ??
        `Heavy queries keep running and are cached when they finish — the same call a little later is usually fast. --timeout accepts up to ${MAX_TIMEOUT_S}s.`,
    },
  );
}

function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
