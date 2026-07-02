/**
 * OAuth for the GEOly MCP endpoint — the "lazy auth" engine.
 *
 * Fully discovery-driven (no hardcoded auth endpoints):
 *   1. Unauthenticated probe of the MCP endpoint → 401 with an RFC 9728
 *      WWW-Authenticate challenge pointing at the protected-resource metadata.
 *   2. PRM → authorization server metadata (authorize/token/registration).
 *   3. Dynamic Client Registration once per endpoint origin; the client id and
 *      the fixed loopback redirect set are persisted so we never trip the
 *      5/min/IP registration rate limit.
 *   4. Authorization-code + PKCE (S256) with a 127.0.0.1 loopback listener;
 *      the browser opens automatically and the URL is also printed to stderr.
 *
 * Concurrency: agents run commands in parallel. A file lock ensures only the
 * first process runs the browser flow; the others wait for credentials.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import {
  CredentialsFile,
  LOCK_PATH,
  StoredClient,
  StoredTokens,
  credentialsPath,
  ensureDir,
  readJson,
  removeFile,
  writeJson,
} from './config.js';
import { Ctx, autoAuthAllowed } from './context.js';
import { GeolyError } from './errors.js';
import { warn } from './output.js';
import { VERSION } from './version.js';

/** Fixed loopback ports registered as redirect URIs (contract §3). */
const LOOPBACK_PORTS = [8760, 8761, 8762, 8763, 8764, 8765, 8766, 8767, 8768, 8769];
const AUTH_TIMEOUT_MS = 180_000;
const LOCK_STALE_MS = 190_000;
const TOKEN_SKEW_MS = 60_000;

interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

// ---- Credentials access ---------------------------------------------------

function endpointOrigin(ctx: Ctx): string {
  return new URL(ctx.endpoint).origin;
}

/** Load credentials for this profile if they match the current endpoint origin. */
export function loadCredentials(ctx: Ctx): CredentialsFile | undefined {
  const creds = readJson<CredentialsFile>(credentialsPath(ctx.profile));
  if (!creds || creds.origin !== endpointOrigin(ctx)) return undefined;
  return creds;
}

function saveCredentials(ctx: Ctx, creds: CredentialsFile): void {
  writeJson(credentialsPath(ctx.profile), creds);
}

export function clearCredentials(ctx: Ctx): void {
  removeFile(credentialsPath(ctx.profile));
}

function tokenFresh(tokens: StoredTokens | undefined): tokens is StoredTokens {
  return !!tokens && tokens.expiresAt - TOKEN_SKEW_MS > Date.now();
}

// ---- Public entry points --------------------------------------------------

/**
 * Return a bearer token, running the lazy-auth browser flow if needed.
 * `forceLogin` (explicit `geoly auth login`) always runs a fresh flow.
 */
export async function ensureAccessToken(ctx: Ctx, forceLogin = false): Promise<string> {
  if (ctx.staticToken) return ctx.staticToken;

  if (!forceLogin) {
    const creds = loadCredentials(ctx);
    if (tokenFresh(creds?.tokens)) return creds!.tokens!.accessToken;
  }

  if (!forceLogin && !autoAuthAllowed(ctx)) {
    throw new GeolyError('auth_expired', 'No valid credentials and automatic authorization is disabled', {
      hint: 'Set GEOLY_TOKEN (read-only, for CI), or run `geoly auth login` interactively once.',
    });
  }

  const peek = (): string | undefined => {
    const again = loadCredentials(ctx);
    return tokenFresh(again?.tokens) ? again!.tokens!.accessToken : undefined;
  };
  return withAuthLock(ctx, async () => {
    // Another process may have finished the flow while we waited for the lock.
    const existing = peek();
    if (existing) return existing;
    const tokens = await runAuthorizationFlow(ctx);
    return tokens.accessToken;
  }, peek);
}

/** Explicit login used by `geoly auth login`. A concurrent peer's fresh login counts. */
export async function login(ctx: Ctx): Promise<StoredTokens> {
  const peek = (): StoredTokens | undefined => {
    const creds = loadCredentials(ctx);
    return tokenFresh(creds?.tokens) ? creds!.tokens : undefined;
  };
  return withAuthLock(ctx, () => runAuthorizationFlow(ctx), peek);
}

// ---- Lock -----------------------------------------------------------------

/**
 * Cross-process lock around the browser flow. If another fresh process holds
 * the lock we poll (via `peek`) for its result instead of opening a second
 * browser window; if the holder dies we take over.
 */
async function withAuthLock<T>(
  ctx: Ctx,
  fn: () => Promise<T>,
  peek: () => T | undefined,
): Promise<T> {
  ensureDir();
  let acquired = tryAcquireLock();
  if (!acquired) {
    warn('geoly: another command is completing authorization — waiting for it…');
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    while (Date.now() < deadline && !acquired) {
      await sleep(1000);
      const peeked = peek();
      if (peeked !== undefined) return peeked;
      acquired = tryAcquireLock(); // holder died or finished without tokens — take over
    }
    if (!acquired) {
      throw new GeolyError('auth_expired', 'Timed out waiting for another process to finish authorization');
    }
  }
  // Ctrl+C during the browser wait must not leave a stale lock behind
  // (otherwise an immediate retry waits for the 190s stale takeover).
  const onSignal = (): void => {
    removeFile(LOCK_PATH);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    removeFile(LOCK_PATH);
  }
}

function tryAcquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    const held = readJson<{ at?: number }>(LOCK_PATH);
    if (!held?.at || Date.now() - held.at > LOCK_STALE_MS) {
      removeFile(LOCK_PATH); // stale lock from a dead process
      try {
        fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ---- The flow itself ------------------------------------------------------

/** Full authorization-code + PKCE flow. Returns and persists fresh tokens. */
async function runAuthorizationFlow(ctx: Ctx): Promise<StoredTokens> {
  const meta = await discover(ctx);
  const client = await ensureClient(ctx, meta);

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const { server, port, waitForCode } = await startLoopback(client.redirectUris);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authorizeUrl = new URL(meta.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'openid profile');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', ctx.endpoint);

  warn(`geoly: authorize in your browser (waiting up to ${AUTH_TIMEOUT_MS / 1000}s):`);
  warn(`  ${authorizeUrl.toString()}`);
  if (!ctx.noBrowser) openBrowser(authorizeUrl.toString());

  let code: string;
  try {
    const result = await waitForCode(AUTH_TIMEOUT_MS);
    if (result.state !== state) {
      throw new GeolyError('auth_expired', 'OAuth state mismatch — aborting for safety');
    }
    code = result.code;
  } finally {
    server.close();
  }

  const tokens = await exchangeCode(ctx, meta, client, code, verifier, redirectUri);
  const creds: CredentialsFile = { origin: endpointOrigin(ctx), client, tokens };
  saveCredentials(ctx, creds);
  warn('geoly: authorized ✓');
  return tokens;
}

/** RFC 9728 → RFC 8414 discovery starting from the MCP endpoint itself. */
async function discover(ctx: Ctx): Promise<AsMetadata> {
  const origin = endpointOrigin(ctx);
  // Probe the endpoint to pick up the resource_metadata challenge; fall back
  // to the conventional root path if the header is missing.
  let prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  try {
    const probe = await fetch(ctx.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(10_000),
    });
    const challenge = probe.headers.get('www-authenticate') ?? '';
    const m = challenge.match(/resource_metadata="([^"]+)"/);
    if (m?.[1]) prmUrl = m[1];
    // Drain the probe body; we only wanted the headers.
    await probe.arrayBuffer().catch(() => undefined);
  } catch {
    /* endpoint unreachable — surfaced below when metadata fetch fails */
  }

  const prm = await fetchJson<{ authorization_servers?: string[] }>(prmUrl);
  const asBase = (prm?.authorization_servers?.[0] ?? origin).replace(/\/$/, '');
  const asMeta =
    (await fetchJson<AsMetadata>(`${asBase}/.well-known/oauth-authorization-server`)) ??
    (await fetchJson<AsMetadata>(`${origin}/.well-known/oauth-authorization-server`));
  if (!asMeta?.authorization_endpoint || !asMeta.token_endpoint) {
    throw new GeolyError('upstream_unavailable', 'Could not discover the OAuth authorization server', {
      hint: `Checked ${prmUrl} — is ${origin} reachable?`,
    });
  }
  return asMeta;
}

/** Reuse the stored DCR client or register a new one (once per endpoint origin). */
async function ensureClient(ctx: Ctx, meta: AsMetadata): Promise<StoredClient> {
  const existing = loadCredentials(ctx)?.client;
  if (existing?.clientId) return existing;

  if (!meta.registration_endpoint) {
    throw new GeolyError('upstream_unavailable', 'Authorization server does not support dynamic client registration');
  }
  const redirectUris = LOOPBACK_PORTS.map((p) => `http://127.0.0.1:${p}/callback`);
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'GEOly CLI',
      client_uri: 'https://www.geoly.ai',
      software_id: 'geoly-cli',
      software_version: VERSION,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    throw new GeolyError('rate_limited', 'Client registration is rate limited — try again in a minute', {
      status: 429,
      retryAfter: parseRetryAfter(res.headers.get('retry-after')) ?? 60,
    });
  }
  if (!res.ok) {
    throw new GeolyError('upstream_unavailable', `Client registration failed (HTTP ${res.status})`, {
      status: res.status,
    });
  }
  const body = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!body.client_id) {
    throw new GeolyError('upstream_unavailable', 'Client registration returned no client_id');
  }
  const client: StoredClient = { clientId: body.client_id, redirectUris };
  if (body.client_secret) client.clientSecret = body.client_secret;
  const creds: CredentialsFile = { origin: endpointOrigin(ctx), ...loadCredentials(ctx), client };
  saveCredentials(ctx, creds);
  return client;
}

/** Exchange the authorization code for tokens and normalize the shape. */
async function exchangeCode(
  ctx: Ctx,
  meta: AsMetadata,
  client: StoredClient,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<StoredTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
    resource: ctx.endpoint,
  });
  if (client.clientSecret) form.set('client_secret', client.clientSecret);
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new GeolyError('auth_expired', `Token exchange failed: ${detail}`, { status: res.status });
  }
  const expiresInMs = (body.expires_in ?? 14 * 24 * 3600) * 1000;
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? 'Bearer',
    scope: body.scope,
    expiresAt: Date.now() + expiresInMs,
  };
}

// ---- Loopback listener ----------------------------------------------------

interface LoopbackHandle {
  server: http.Server;
  port: number;
  waitForCode: (timeoutMs: number) => Promise<{ code: string; state: string }>;
}

/** Bind the first free port from the registered set and wait for /callback. */
async function startLoopback(registered: string[]): Promise<LoopbackHandle> {
  const ports = registered
    .map((u) => Number(new URL(u).port))
    .filter((p) => Number.isFinite(p) && p > 0);
  let resolveCode: (v: { code: string; state: string }) => void;
  let rejectCode: (e: Error) => void;
  const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<html><body style="font-family:system-ui;text-align:center;padding-top:4rem">` +
        `<h2>${err ? 'Authorization failed' : 'GEOly CLI authorized'}</h2>` +
        `<p>You can close this window and return to your terminal.</p></body></html>`,
    );
    if (err) rejectCode(new GeolyError('auth_expired', `Authorization was denied: ${err}`));
    else if (code) resolveCode({ code, state });
  });

  const port = await bindFirstFree(server, ports);
  return {
    server,
    port,
    waitForCode: (timeoutMs) =>
      Promise.race([
        codePromise,
        sleep(timeoutMs).then(() => {
          throw new GeolyError('auth_expired', 'Timed out waiting for browser authorization', {
            hint: 'Re-run the command, or use --no-browser and open the printed URL manually.',
          });
        }),
      ]),
  };
}

/** Try each registered port in order; exact redirect_uri match is required server-side. */
function bindFirstFree(server: http.Server, ports: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number): void => {
      if (i >= ports.length) {
        reject(
          new GeolyError('auth_expired', 'All registered callback ports are busy', {
            hint: `Free one of ports ${ports.join(', ')} and retry.`,
          }),
        );
        return;
      }
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') tryPort(i + 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(ports[i], '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryPort(0);
  });
}

// ---- Small helpers ----------------------------------------------------------

/** Open the system browser, best-effort; the URL is always printed as fallback. */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* fallback: user opens the printed URL */
  }
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
