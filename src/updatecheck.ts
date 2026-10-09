/**
 * Daily, best-effort update check (contract §Update): at most once per 24h, never throws,
 * never blocks the result.
 *
 * - Released binaries (auto-update on): hand off to a detached `geoly upgrade --auto` child —
 *   works for scripts and agent hosts too, not just terminals. The next interactive run prints
 *   one line about what it installed.
 * - Auto-update off (`GEOLY_NO_AUTO_UPDATE=1`, CI, dev checkout): the old TTY-only notice.
 * - Skill freshness in agent hosts: the background child refreshes hosts that are behind itself
 *   (see `backgroundUpdate` in commands/upgrade.ts); without auto-update it stays a TTY nudge
 *   (1.5s budget).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAST_UPDATE_CHECK_PATH, ensureDir } from './config.js';
import {
  AUTO_UPDATE_CHILD_ENV,
  autoUpdateDisabledReason,
  spawnBackgroundUpdate,
  takeAutoUpdateMarker,
} from './selfupdate.js';
import { SKILL_NAME, hostsWithSkill, installedVersion } from './skills.js';
import { DEFAULT_ENDPOINT, VERSION, isNewer, resolveManifestUrl } from './version.js';

const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export async function maybeNotifyUpdate(): Promise<void> {
  if (process.env[AUTO_UPDATE_CHILD_ENV]) return;
  const tty = process.stderr.isTTY === true;
  try {
    if (tty) {
      const done = takeAutoUpdateMarker();
      if (done) process.stderr.write(`geoly: updated v${done.from} → v${done.to} in the background\n`);
    }
  } catch {
    /* best-effort */
  }

  const autoOff = autoUpdateDisabledReason();
  // Without auto-update there is nothing to do off a terminal (the notice is the only output).
  if (autoOff && !tty) return;
  try {
    const last = Number(fs.readFileSync(LAST_UPDATE_CHECK_PATH, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) return;
  } catch {
    /* first run — proceed */
  }
  try {
    ensureDir();
    fs.writeFileSync(LAST_UPDATE_CHECK_PATH, String(Date.now()));
    const autoStarted = !autoOff && spawnBackgroundUpdate();
    if (!tty) return;
    // The background child brings stale host skills up to date on its own — a nudge to run
    // `geoly init` for something already being refreshed would only be noise.
    const [binary, skill] = await Promise.all([
      autoStarted ? undefined : checkBinary(),
      autoStarted ? undefined : checkSkill(),
    ]);
    if (binary) process.stderr.write(`${binary}\n`);
    if (skill) process.stderr.write(`${skill}\n`);
  } catch {
    /* best-effort only */
  }
}

async function checkBinary(): Promise<string | undefined> {
  const res = await fetch(resolveManifestUrl(), { signal: AbortSignal.timeout(1500) });
  if (!res.ok) return undefined;
  const manifest = (await res.json()) as { latest?: string };
  if (manifest.latest && isNewer(manifest.latest, VERSION)) {
    return `geoly: v${manifest.latest} is available (you have v${VERSION}) — run \`geoly upgrade\``;
  }
  return undefined;
}

/**
 * The skill installed into agent hosts is a copy; the app publishes the current one. Once a
 * day, compare and nudge. Only used when no background update was started (auto-update off —
 * dev checkouts, CI, `GEOLY_NO_AUTO_UPDATE=1` — or the spawn failed): then nothing rewrites a
 * host's files on its own, so the user is told to run `geoly init` / `geoly upgrade`.
 */
async function checkSkill(): Promise<string | undefined> {
  const hosts = hostsWithSkill();
  if (!hosts.length) return undefined;
  const origin = new URL(process.env.GEOLY_MCP_ENDPOINT?.trim() || DEFAULT_ENDPOINT).origin;
  const res = await fetch(`${origin}/skills/${SKILL_NAME}.json`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) return undefined;
  const live = (await res.json()) as { version?: string };
  if (!live.version) return undefined;
  const stale = hosts.filter((h) => {
    const v = installedVersion(path.join(os.homedir(), h.skillsDir, SKILL_NAME));
    return v !== undefined && isNewer(live.version!, v);
  });
  if (!stale.length) return undefined;
  return `geoly: skill ${live.version} is available for ${stale.map((h) => h.label).join(', ')} — run \`geoly init\` to refresh`;
}

/** Re-exported for existing importers; the implementation lives in version.ts (a leaf module). */
export { isNewer };
