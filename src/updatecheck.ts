/**
 * Daily, best-effort update notice (contract §2): checked at most once per
 * 24h, 1.5s network budget, TTY-only, never throws, never blocks the result.
 */
import * as fs from 'node:fs';
import { LAST_UPDATE_CHECK_PATH, ensureDir } from './config.js';
import { MANIFEST_URL, VERSION } from './version.js';

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
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const manifest = (await res.json()) as { latest?: string };
    if (manifest.latest && isNewer(manifest.latest, VERSION)) {
      process.stderr.write(`geoly: v${manifest.latest} is available (you have v${VERSION}) — run \`geoly upgrade\`\n`);
    }
  } catch {
    /* best-effort only */
  }
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
