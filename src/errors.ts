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
  | 'subscription_required'
  | 'upstream_unavailable'
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
};

const KIND_EXIT: Record<ErrorKind, number> = {
  auth_expired: EXIT.auth!,
  grant_missing: EXIT.auth!,
  rate_limited: EXIT.rateLimited!,
  subscription_required: EXIT.subscription!,
  upstream_unavailable: EXIT.upstream!,
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
}

export class GeolyError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly tool?: string;
  readonly retryAfter?: number;
  readonly hint?: string;

  constructor(kind: ErrorKind, message: string, opts: GeolyErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'GeolyError';
    this.kind = kind;
    this.status = opts.status;
    this.tool = opts.tool;
    this.retryAfter = opts.retryAfter;
    this.hint = opts.hint;
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
    return out;
  }
}

/** Wrap unknown thrown values so every failure path speaks the contract. */
export function asGeolyError(err: unknown): GeolyError {
  if (err instanceof GeolyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new GeolyError('tool_error', message, { cause: err });
}
