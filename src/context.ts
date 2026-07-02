/**
 * Run context: everything a command needs, resolved once from flags + env.
 * Endpoint override is allow-listed (HTTPS *.geoly.ai, plus localhost for
 * development) so a hostile env var can't redirect tokens elsewhere.
 */
import { GeolyError } from './errors.js';
import { DEFAULT_ENDPOINT } from './version.js';

export interface Ctx {
  endpoint: string;
  profile: string;
  org?: string;
  output: 'json' | 'raw';
  errorFormat: 'human' | 'json';
  quiet: boolean;
  timeoutMs: number;
  noAutoAuth: boolean;
  noBrowser: boolean;
  /** Legacy geom_ static token from GEOLY_TOKEN — read-only, never opens a browser. */
  staticToken?: string;
}

export interface CtxInput {
  profile?: string;
  org?: string;
  output?: string;
  errorFormat?: string;
  quiet?: boolean;
  timeout?: string;
  noAutoAuth?: boolean;
  noBrowser?: boolean;
}

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

/** Validate an endpoint override against the allowlist. */
function resolveEndpoint(): string {
  const raw = process.env.GEOLY_MCP_ENDPOINT?.trim();
  if (!raw) return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeolyError('usage_error', `GEOLY_MCP_ENDPOINT is not a valid URL: ${raw}`);
  }
  const host = url.hostname;
  const isGeoly = url.protocol === 'https:' && (host === 'geoly.ai' || host.endsWith('.geoly.ai'));
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isGeoly && !isLocal) {
    throw new GeolyError(
      'usage_error',
      `GEOLY_MCP_ENDPOINT must be https://*.geoly.ai or localhost, got: ${url.origin}`,
      { hint: 'This guard prevents your token from being sent to an arbitrary server.' },
    );
  }
  return url.toString().replace(/\/$/, '');
}

/** Build the run context from parsed command options + environment. */
export function makeCtx(input: CtxInput): Ctx {
  const output = input.output ?? 'json';
  if (output !== 'json' && output !== 'raw') {
    throw new GeolyError('usage_error', `--output must be json or raw, got: ${output}`);
  }
  const errorFormat = input.errorFormat ?? 'human';
  if (errorFormat !== 'human' && errorFormat !== 'json') {
    throw new GeolyError('usage_error', `--error-format must be human or json, got: ${errorFormat}`);
  }
  let timeoutS = DEFAULT_TIMEOUT_S;
  if (input.timeout !== undefined) {
    timeoutS = Number(input.timeout);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new GeolyError('usage_error', `--timeout must be a positive number of seconds`);
    }
    timeoutS = Math.min(timeoutS, MAX_TIMEOUT_S);
  }
  const staticToken = process.env.GEOLY_TOKEN?.trim() || undefined;
  return {
    endpoint: resolveEndpoint(),
    profile: sanitizeProfile(input.profile ?? 'default'),
    org: input.org?.trim() || undefined,
    output,
    errorFormat,
    quiet: input.quiet ?? false,
    timeoutMs: timeoutS * 1000,
    noAutoAuth: input.noAutoAuth ?? false,
    noBrowser: input.noBrowser ?? false,
    staticToken,
  };
}

/** Profile names become file names — keep them boring. */
function sanitizeProfile(profile: string): string {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(profile)) {
    throw new GeolyError('usage_error', `--profile may only contain [a-zA-Z0-9._-], got: ${profile}`);
  }
  return profile;
}

/** Lazy auth is suppressed in CI and when explicitly disabled (contract §auth). */
export function autoAuthAllowed(ctx: Ctx): boolean {
  if (ctx.staticToken) return false;
  if (ctx.noAutoAuth) return false;
  if (process.env.GEOLY_NO_AUTO_AUTH) return false;
  if (process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0') return false;
  return true;
}
