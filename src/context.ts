/**
 * Run context: everything a command needs, resolved once from flags + env.
 * Endpoint override is allow-listed (HTTPS *.geoly.ai, plus localhost for
 * development) so a hostile env var can't redirect tokens elsewhere. The guard is on the
 * host only: any path is accepted, so `/api/mcp/v1` (the default), the unversioned `/api/mcp`
 * and a future `/api/mcp/v<n>` all pass.
 */
import { readSettings } from './config.js';
import { GeolyError } from './errors.js';
import { DEFAULT_ENDPOINT } from './version.js';

export interface Ctx {
  endpoint: string;
  profile: string;
  org?: string;
  output: 'json' | 'raw';
  errorFormat: 'human' | 'json';
  quiet: boolean;
  /**
   * Deadline for ordinary requests (tools/list, initialize, the Agent API's lookups and the
   * `geoly run` headers wait): `--timeout`, else 30 s. A `tools/call` does NOT use this — its
   * deadline comes from the tool's advertised server budget (see deadline.ts `toolDeadlineMs`).
   */
  timeoutMs: number;
  /** `--timeout` exactly as given (ms), when the user passed one; undefined means "use the defaults". */
  timeoutOverrideMs?: number;
  noAutoAuth: boolean;
  noBrowser: boolean;
  /** Force the paste-code sign-in (no loopback listener); auto-detected for SSH / CI / no display. */
  remote: boolean;
  /**
   * API key (`geom_…`) from GEOLY_TOKEN — never opens a browser. Its permissions (read, and
   * whichever write tools the key was granted in Settings → Developers → API keys) are decided
   * server-side; the tool list the server returns is the source of truth.
   */
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
  remote?: boolean;
}

/**
 * 401 hint when GEOLY_TOKEN is set. GEOLY_TOKEN takes an API key (`geom_…`) created in
 * Settings → Developers → API keys; such keys are current, not legacy, and can carry write
 * permissions — so the old "legacy tokens can no longer be created" wording sent people away
 * from the right fix.
 */
export const API_KEY_REJECTED_HINT =
  'GEOLY_TOKEN was rejected — the API key may be revoked, expired or mistyped. Create a new one in Settings → Developers → API keys, or unset GEOLY_TOKEN and run `geoly auth login`.';

/** Ordinary requests (tool list, lookups, `geoly run` headers). Tool calls: see deadline.ts. */
const DEFAULT_TIMEOUT_S = 30;
/** Upper bound for an explicit `--timeout`; also caps a server-derived tool deadline. */
export const MAX_TIMEOUT_S = 300;

/**
 * Resolve the MCP endpoint: GEOLY_MCP_ENDPOINT when set (host allow-listed, path free), else
 * DEFAULT_ENDPOINT. Nothing under ~/.geoly stores an endpoint, so there is no saved value that
 * could pin an old path — only an explicit env override keeps `/api/mcp`, which still works.
 */
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
  let timeoutOverrideMs: number | undefined;
  if (input.timeout !== undefined) {
    timeoutS = Number(input.timeout);
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new GeolyError('usage_error', `--timeout must be a positive number of seconds`);
    }
    // `--help` states the max; silently clamping 999 → max taught agents the flag was elastic.
    if (timeoutS > MAX_TIMEOUT_S) {
      throw new GeolyError('usage_error', `--timeout must be at most ${MAX_TIMEOUT_S} seconds, got ${timeoutS}`, {
        hint: 'For `geoly run`, --timeout bounds each request (connect + first byte); how long to follow a run is --wait.',
      });
    }
    timeoutOverrideMs = timeoutS * 1000;
  }
  const staticToken = process.env.GEOLY_TOKEN?.trim() || undefined;
  const profile = sanitizeProfile(input.profile ?? 'default');
  // 没给 --org 就用这个 profile 上一次选定的组织：多组织用户不该每条命令都带一遍
  const org = input.org?.trim() || readSettings(profile).defaultOrg || undefined;
  return {
    endpoint: resolveEndpoint(),
    profile,
    org,
    output,
    errorFormat,
    quiet: input.quiet ?? false,
    timeoutMs: timeoutS * 1000,
    timeoutOverrideMs,
    noAutoAuth: input.noAutoAuth ?? false,
    noBrowser: input.noBrowser ?? false,
    remote: input.remote ?? false,
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
