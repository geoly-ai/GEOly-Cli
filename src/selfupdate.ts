/**
 * Self-update core shared by `geoly upgrade` (explicit) and the daily background auto-update.
 *
 * Why auto-update exists: the CLI mostly runs under scripts and agent hosts, where the TTY-only
 * update notice is never seen — production traffic showed most calls still coming from a
 * two-month-old release. Now, at most once a day, any command spawns a detached
 * `geoly upgrade --auto` child that swaps the binary in place; the running command is never
 * delayed and never sees the swap (the rename is safe while the old image is executing, incl.
 * Windows). The next interactive run prints one line saying what changed.
 *
 * Off switches: `GEOLY_NO_AUTO_UPDATE=1`, any `CI` environment, and non-compiled installs
 * (development checkouts run under node and update via git).
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { GEOLY_DIR, ensureDir, readJson, removeFile, writeJson } from './config.js';
import { GeolyError } from './errors.js';
import { resolveManifestUrl } from './version.js';

export interface ManifestFile {
  latest?: string;
  files?: Array<{ os: string; arch: string; url: string; sha256: string }>;
}

/** Set on the detached child so it never spawns another one. */
export const AUTO_UPDATE_CHILD_ENV = 'GEOLY_AUTO_UPDATE_CHILD';
/** Written by a successful background update; read (and removed) by the next interactive run. */
export const AUTO_UPDATE_MARKER_PATH = path.join(GEOLY_DIR, 'last-auto-update.json');
const AUTO_UPDATE_LOCK_PATH = path.join(GEOLY_DIR, 'upgrade.lock');
/** A lock older than this belongs to a child that died mid-download. */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** True for released single-file binaries (the only installs that can replace themselves). */
export function isCompiledInstall(): boolean {
  return path.basename(process.execPath).toLowerCase().startsWith('geoly');
}

/** Why background auto-update is off for this process, or undefined when it is on. */
export function autoUpdateDisabledReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const flag = env.GEOLY_NO_AUTO_UPDATE?.trim().toLowerCase();
  if (flag && flag !== '0' && flag !== 'false') return 'GEOLY_NO_AUTO_UPDATE is set';
  if (env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false') return 'running in CI';
  if (env[AUTO_UPDATE_CHILD_ENV]) return 'already the auto-update child';
  if (!isCompiledInstall()) return 'not a compiled install';
  return undefined;
}

/**
 * Start `geoly upgrade --auto` fully detached (own process group, no stdio, not awaited).
 * Returns false when the spawn itself failed — the caller falls back to the plain notice.
 */
export function spawnBackgroundUpdate(): boolean {
  try {
    const child = spawn(process.execPath, ['upgrade', '--auto'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, [AUTO_UPDATE_CHILD_ENV]: '1' },
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Fetch the release manifest (`latest` + per-platform files). */
export async function fetchManifest(timeoutMs: number): Promise<ManifestFile> {
  const res = await fetch(resolveManifestUrl(), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new GeolyError('upstream_unavailable', `Could not fetch the release manifest (HTTP ${res.status})`, {
      status: res.status,
    });
  }
  const manifest = (await res.json()) as ManifestFile;
  if (!manifest.latest || !manifest.files?.length) {
    throw new GeolyError('upstream_unavailable', 'Release manifest is malformed');
  }
  return manifest;
}

/**
 * Download the manifest entry for this os/arch, verify its sha256, and swap it in for the
 * running binary. Throws GeolyError on any failure; the original binary is always left in place.
 */
export async function installRelease(manifest: ManifestFile, onStatus: (msg: string) => void = () => undefined): Promise<{ path: string; to: string }> {
  const binPath = process.execPath;
  const to = manifest.latest!;
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const entry = manifest.files?.find((f) => f.os === osName && (f.arch === arch || f.arch === `${arch}-baseline`));
  if (!entry) {
    throw new GeolyError('upstream_unavailable', `No binary published for ${osName}/${arch}`);
  }
  // A poisoned manifest must not be able to point the download anywhere else
  // (its sha256 would just match the attacker binary) — same allowlist as install.sh.
  assertTrustedDownloadUrl(entry.url);

  onStatus(`geoly: downloading v${to} for ${osName}/${arch}…`);
  const download = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) {
    throw new GeolyError('upstream_unavailable', `Download failed (HTTP ${download.status})`, { status: download.status });
  }
  let bytes = Buffer.from(await download.arrayBuffer());

  // Integrity gate before anything touches disk paths we care about.
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256.toLowerCase()) {
    throw new GeolyError('upstream_unavailable', 'Checksum mismatch — refusing to install', {
      hint: `expected ${entry.sha256}, got ${digest}`,
    });
  }
  if (entry.url.endsWith('.gz')) bytes = zlib.gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });

  // Atomic-ish swap: write next to the target, move the old binary aside
  // (allowed even while running, incl. Windows), rename the new one in.
  const dir = path.dirname(binPath);
  cleanupOldImages(dir);
  const tmpNew = path.join(dir, `.geoly-new-${process.pid}`);
  const old = path.join(dir, `.geoly-old-${process.pid}`);
  fs.writeFileSync(tmpNew, bytes, { mode: 0o755 });
  try {
    fs.renameSync(binPath, old);
    fs.renameSync(tmpNew, binPath);
    fs.rm(old, () => undefined); // Windows may hold the running image; swept on the next update
  } catch (err) {
    // Roll back so the user is never left without a binary.
    try {
      if (!fs.existsSync(binPath) && fs.existsSync(old)) fs.renameSync(old, binPath);
    } finally {
      fs.rm(tmpNew, () => undefined);
    }
    throw new GeolyError('tool_error', `Could not replace the binary: ${(err as Error).message}`, {
      hint: `Download manually from ${entry.url} or re-run the installer: curl -fsSL https://geoly.ai/install.sh | sh`,
    });
  }
  return { path: binPath, to };
}

/**
 * Old images Windows refused to delete while they were running (every parallel `geoly call`
 * of a busy script holds one). Best-effort: anything still in use just stays until next time.
 */
function cleanupOldImages(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      // only images already swapped out — a `.geoly-new-*` may be a concurrent manual upgrade mid-write
      if (name.startsWith('.geoly-old-')) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* still running somewhere (Windows) — next time */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Cross-process lock for the background child: busy scripts start many `geoly` processes at
 * once, and only one of them should download. Returns a release function, or undefined when
 * another update is already in flight.
 */
export function acquireUpdateLock(): (() => void) | undefined {
  ensureDir();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(AUTO_UPDATE_LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => removeFile(AUTO_UPDATE_LOCK_PATH);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      try {
        const age = Date.now() - fs.statSync(AUTO_UPDATE_LOCK_PATH).mtimeMs;
        if (age < STALE_LOCK_MS) return undefined;
        removeFile(AUTO_UPDATE_LOCK_PATH);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface AutoUpdateMarker {
  from: string;
  to: string;
  at: string;
}

export function writeAutoUpdateMarker(marker: AutoUpdateMarker): void {
  try {
    writeJson(AUTO_UPDATE_MARKER_PATH, marker);
  } catch {
    /* best-effort */
  }
}

/** Read and remove the marker a background update left behind (one line, once). */
export function takeAutoUpdateMarker(): AutoUpdateMarker | undefined {
  const marker = readJson<AutoUpdateMarker>(AUTO_UPDATE_MARKER_PATH);
  if (marker) removeFile(AUTO_UPDATE_MARKER_PATH);
  return marker?.to ? marker : undefined;
}

/** https + known hosts only — mirrors install.sh's allowed_url(). */
function assertTrustedDownloadUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GeolyError('upstream_unavailable', `Manifest contains an invalid download URL: ${url}`);
  }
  const okHost =
    u.hostname === 'github.com' ||
    u.hostname === 'objects.githubusercontent.com' ||
    u.hostname === 'raw.githubusercontent.com' ||
    u.hostname === 'geoly.ai' ||
    u.hostname.endsWith('.geoly.ai');
  if (u.protocol !== 'https:' || !okHost) {
    throw new GeolyError('upstream_unavailable', `Refusing download from untrusted URL: ${u.origin}`);
  }
}
