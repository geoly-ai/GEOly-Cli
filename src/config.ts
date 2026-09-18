/**
 * Local state under ~/.geoly:
 *   credentials-<profile>.json  (0600) — DCR client + OAuth tokens per endpoint origin
 *   cache-<profile>.json               — tools/list cache (60s TTL, stale fallback)
 *   auth.lock                          — cross-process lock so concurrent lazy-auth
 *                                        opens exactly one browser window
 *   last-update-check                  — timestamp for the daily update notice
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const GEOLY_DIR = path.join(os.homedir(), '.geoly');

/** Ensure ~/.geoly exists with owner-only permissions (mode is a no-op on Windows). */
export function ensureDir(): void {
  fs.mkdirSync(GEOLY_DIR, { recursive: true, mode: 0o700 });
}

export function credentialsPath(profile: string): string {
  return path.join(GEOLY_DIR, `credentials-${profile}.json`);
}

export function cachePath(profile: string): string {
  return path.join(GEOLY_DIR, `cache-${profile}.json`);
}

export const LOCK_PATH = path.join(GEOLY_DIR, 'auth.lock');
export const LAST_UPDATE_CHECK_PATH = path.join(GEOLY_DIR, 'last-update-check');

/** A remote (paste-code) sign-in that was started but not yet completed with `--code`. */
export function pendingAuthPath(profile: string): string {
  return path.join(GEOLY_DIR, `pending-auth-${profile}.json`);
}

/** Where `geoly run` drops each run's full receipt: `./.geoly/runs/<run_id>.json` under the CWD. */
export function runsDir(cwd = process.cwd()): string {
  return path.join(cwd, '.geoly', 'runs');
}

/** Read a JSON file; returns undefined when missing or unparseable (self-healing). */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write JSON atomically with owner-only permissions. */
export function writeJson(file: string, value: unknown): void {
  ensureDir();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeFile(file: string): void {
  try {
    fs.rmSync(file);
  } catch {
    /* already gone */
  }
}

// ---- Credential shapes ---------------------------------------------------

export interface StoredClient {
  /** OAuth client from Dynamic Client Registration, keyed to an endpoint origin. */
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

export interface StoredTokens {
  accessToken: string;
  tokenType: string;
  scope?: string;
  /** Epoch ms after which we treat the token as expired (includes 60s skew). */
  expiresAt: number;
}

export interface CredentialsFile {
  /** Origin of the MCP endpoint these credentials belong to. */
  origin: string;
  client?: StoredClient;
  tokens?: StoredTokens;
}

/**
 * State of a remote sign-in between `auth login --remote` (prints the URL) and
 * `auth login --code` (finishes it). The PKCE verifier lives only here, on this machine —
 * the code the user pastes is useless without it.
 */
export interface PendingAuthFile {
  origin: string;
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  tokenEndpoint: string;
  /** The URL the user must open — kept so a second command can show it again instead of starting over. */
  authorizeUrl: string;
  /** Epoch ms; a pending sign-in older than this is discarded. */
  expiresAt: number;
}

/**
 * Per-profile preferences that survive between runs. Currently just the organization:
 * a multi-org user should pick once, not on every command.
 */
export interface SettingsFile {
  defaultOrg?: string;
}

export function settingsPath(profile: string): string {
  return path.join(GEOLY_DIR, `settings-${profile}.json`);
}

export function readSettings(profile: string): SettingsFile {
  return readJson<SettingsFile>(settingsPath(profile)) ?? {};
}

export function saveDefaultOrg(profile: string, orgId: string): void {
  writeJson(settingsPath(profile), { ...readSettings(profile), defaultOrg: orgId });
}

export interface ToolsCacheFile {
  endpoint: string;
  fetchedAt: number;
  tools: unknown[];
}
