/** CLI version. Kept in sync with the release manifest by the release workflow. */
export const VERSION = '0.3.3';

/** MCP protocol version this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Default remote MCP endpoint (the single production tool surface). */
export const DEFAULT_ENDPOINT = 'https://app.geoly.ai/api/mcp';

/**
 * Release manifest consumed by `geoly upgrade` and the daily update notice.
 * The `releases/latest/download` URL always points at the newest release's
 * asset — no domain routing dependency. geoly.ai/cli/manifest.json is a
 * Cloudflare redirect to the same place.
 */
export const MANIFEST_URL = 'https://github.com/geoly-ai/GEOly-Cli/releases/latest/download/manifest.json';

/**
 * Release base URL override (same variable install.sh / install.ps1 honor): a mirror on
 * *.geoly.ai for networks where github.com is slow or blocked. When set, both the daily
 * update notice and `geoly upgrade` read the manifest from the mirror and never touch github.
 * Anything outside the allow-list is ignored (with a warning) rather than trusted.
 */
export function resolveManifestUrl(): string {
  const raw = process.env.GEOLY_INSTALL_BASE?.trim();
  if (!raw) return MANIFEST_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    process.stderr.write(`geoly: ignoring GEOLY_INSTALL_BASE (not a URL): ${raw}\n`);
    return MANIFEST_URL;
  }
  const okHost = u.hostname === 'github.com' || u.hostname === 'geoly.ai' || u.hostname.endsWith('.geoly.ai');
  if (u.protocol !== 'https:' || !okHost) {
    process.stderr.write(`geoly: ignoring GEOLY_INSTALL_BASE (must be https on github.com / *.geoly.ai): ${u.origin}\n`);
    return MANIFEST_URL;
  }
  return `${raw.replace(/\/$/, '')}/latest/download/manifest.json`;
}

/**
 * Compare dotted versions numerically segment by segment (`0.10.0` is newer than `0.9.9`).
 * Lives here, in a leaf module, because both the update check and the skill installer need it
 * and skills.ts must not import updatecheck.ts (which imports skills.ts).
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((p) => parseInt(p, 10) || 0);
  const b = current.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
