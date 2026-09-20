/**
 * Daily, best-effort update notice (contract §2): checked at most once per
 * 24h, 1.5s network budget, TTY-only, never throws, never blocks the result.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAST_UPDATE_CHECK_PATH, ensureDir } from './config.js';
import { SKILL_NAME, hostsWithSkill, installedVersion } from './skills.js';
import { DEFAULT_ENDPOINT, VERSION, resolveManifestUrl } from './version.js';

const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export async function maybeNotifyUpdate(): Promise<void> {
  try {
    if (!process.stderr.isTTY) return;
    const last = Number(fs.readFileSync(LAST_UPDATE_CHECK_PATH, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) return;
  } catch {
    /* first run — proceed */
  }
  try {
    ensureDir();
    fs.writeFileSync(LAST_UPDATE_CHECK_PATH, String(Date.now()));
    const [binary, skill] = await Promise.all([checkBinary(), checkSkill()]);
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
 * day, compare and nudge — never rewrite a host's files behind the user's back (that is what
 * `geoly init` / `geoly upgrade` are for).
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

/** Compare dotted versions numerically segment by segment. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((p) => parseInt(p, 10) || 0);
  const b = current.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
