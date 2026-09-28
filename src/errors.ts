/**
 * Error model. This is part of the public contract (CONTRACT.md):
 * stable `kind` values, stable exit codes. Everything the CLI throws
 * on purpose is a GeolyError; anything else is a bug surfaced as kind
 * `tool_error` with exit code 1.
 */

export type ErrorKind =
  | 'auth_expired'
  | 'grant_missing'
  | 'rate_limited'
  /** The organization has no active subscription at all. */
  | 'subscription_required'
  /** Subscribed, but this period's AI Credits are used up — a different fix entirely. */
  | 'quota_exhausted'
  | 'upstream_unavailable'
  /**
   * The CLI's own deadline ran out before the server answered — before the response headers or
   * while the body was still streaming. Distinct from `upstream_unavailable` (the server or the
   * network said something went wrong): here nothing went wrong yet, the answer just did not
   * arrive in time and the server may still be working. Same exit code as upstream trouble (6):
   * the right move is the same — one retry after a short back-off, or a longer `--timeout`.
   */
  | 'timeout'
  | 'tool_error'
  | 'usage_error'
  | 'write_blocked';

/** Contract exit codes (CONTRACT.md §Exit codes). */
export const EXIT: Record<string, number> = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  rateLimited: 4,
  subscription: 5,
  upstream: 6,
  quota: 7,
};

/**
 * The one place the exit-code table is written down. `--help`, README and the skill file all
 * render from here — a hand-copied table drifted once already (README stopped at 6 while
 * `quota` = 7 had shipped).
 */
export const EXIT_CODE_TABLE: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: 0, meaning: 'ok (a `running` hand-off from `geoly run` is also 0 — it is not a failure)' },
  { code: 1, meaning: 'tool / run error — the server answered, the operation itself failed' },
  { code: 2, meaning: 'usage error — bad flags or parameters; nothing was sent' },
  { code: 3, meaning: 'auth — no valid credentials (run `geoly auth login`)' },
  { code: 4, meaning: 'rate limited — honor `retryAfter` before retrying' },
  { code: 5, meaning: 'subscription required — the organization has no active plan' },
  { code: 6, meaning: 'upstream unavailable or timed out (kind `timeout`) — network / gateway trouble, or no answer within the deadline; a short back-off then one retry is reasonable' },
  { code: 7, meaning: "credits exhausted — this period's credits are used up" },
];

/** Markdown-ish rendering shared by help text and docs. */
export function renderExitCodeTable(): string {
  return EXIT_CODE_TABLE.map((e) => `  ${e.code}  ${e.meaning}`).join('\n');
}

const KIND_EXIT: Record<ErrorKind, number> = {
  auth_expired: EXIT.auth!,
  grant_missing: EXIT.auth!,
  rate_limited: EXIT.rateLimited!,
  subscription_required: EXIT.subscription!,
  quota_exhausted: EXIT.quota!,
  upstream_unavailable: EXIT.upstream!,
  timeout: EXIT.upstream!,
  tool_error: EXIT.general!,
  usage_error: EXIT.usage!,
  write_blocked: EXIT.general!,
};

export interface GeolyErrorOptions {
  status?: number;
  tool?: string;
  retryAfter?: number;
  hint?: string;
  cause?: unknown;
  /**
   * Whether re-sending the exact same request could plausibly succeed.
   *
   * Only set for failures that happen *before* any bytes of a response stream have been
   * consumed. A half-streamed turn must never be retried: the model already produced (and
   * we were already billed for) output, so a retry would duplicate both.
   */
  retryable?: boolean;
  /**
   * The exact command that moves things forward, when one exists (e.g. after a remote
   * sign-in was started: `geoly auth login --code <code>`). Agents run it verbatim.
   */
  next?: string;
  /** kind `timeout`: the client-side deadline that ran out, in milliseconds. */
  deadlineMs?: number;
  /** kind `timeout`: the tool's server-side time budget as advertised in tools/list, when known. */
  serverBudgetMs?: number;
}

export class GeolyError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly tool?: string;
  readonly retryAfter?: number;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly next?: string;
  readonly deadlineMs?: number;
  readonly serverBudgetMs?: number;

  constructor(kind: ErrorKind, message: string, opts: GeolyErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'GeolyError';
    this.kind = kind;
    this.status = opts.status;
    this.tool = opts.tool;
    this.retryable = opts.retryable === true;
    this.retryAfter = opts.retryAfter;
    this.hint = opts.hint;
    this.next = opts.next;
    this.deadlineMs = opts.deadlineMs;
    this.serverBudgetMs = opts.serverBudgetMs;
  }

  get exitCode(): number {
    return KIND_EXIT[this.kind] ?? EXIT.general!;
  }

  /** Stable machine-readable shape for `--error-format json`. */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { kind: this.kind, message: this.message };
    if (this.status !== undefined) out.status = this.status;
    if (this.tool !== undefined) out.tool = this.tool;
    if (this.retryAfter !== undefined) out.retryAfter = this.retryAfter;
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.next !== undefined) out.next = this.next;
    // Seconds, like retryAfter — an agent compares them with the --timeout it passed.
    if (this.deadlineMs !== undefined) out.deadlineSeconds = this.deadlineMs / 1000;
    if (this.serverBudgetMs !== undefined) out.serverBudgetSeconds = this.serverBudgetMs / 1000;
    return out;
  }
}

/** Wrap unknown thrown values so every failure path speaks the contract. */
export function asGeolyError(err: unknown): GeolyError {
  if (err instanceof GeolyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new GeolyError('tool_error', message, { cause: err });
}
