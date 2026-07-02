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

export interface ToolsCacheFile {
  endpoint: string;
  fetchedAt: number;
  tools: unknown[];
}
