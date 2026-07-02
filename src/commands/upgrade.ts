/**
 * `geoly upgrade` — manifest-driven self-update (no package manager).
 * Reads the release manifest, downloads the entry matching this os/arch,
 * verifies its sha256, then atomically swaps the running binary.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Command } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { printResult, status } from '../output.js';
import { MANIFEST_URL, VERSION } from '../version.js';
import { isNewer } from '../updatecheck.js';
import { GeolyCommand } from './base.js';

interface ManifestFile {
  latest?: string;
  files?: Array<{ os: string; arch: string; url: string; sha256: string }>;
}

export class UpgradeCommand extends GeolyCommand {
  static paths = [['upgrade']];
  static usage = Command.Usage({ description: 'Update the CLI binary to the latest release.' });

  protected async run(ctx: Ctx): Promise<number> {
    const binPath = process.execPath;
    if (!path.basename(binPath).toLowerCase().startsWith('geoly')) {
      throw new GeolyError('usage_error', 'This is not a compiled install — upgrade is only for released binaries', {
        hint: 'Development checkouts update via git; installed binaries via `geoly upgrade`.',
      });
    }

    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new GeolyError('upstream_unavailable', `Could not fetch the release manifest (HTTP ${res.status})`, {
        status: res.status,
      });
    }
    const manifest = (await res.json()) as ManifestFile;
    if (!manifest.latest || !manifest.files?.length) {
      throw new GeolyError('upstream_unavailable', 'Release manifest is malformed');
    }
    if (!isNewer(manifest.latest, VERSION)) {
      printResult(ctx, { upToDate: true, version: VERSION });
      return 0;
    }

    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const entry = manifest.files.find((f) => f.os === osName && (f.arch === arch || f.arch === `${arch}-baseline`));
    if (!entry) {
      throw new GeolyError('upstream_unavailable', `No binary published for ${osName}/${arch}`);
    }
    // A poisoned manifest must not be able to point the download anywhere else
    // (its sha256 would just match the attacker binary) — same allowlist as install.sh.
    assertTrustedDownloadUrl(entry.url);

    status(ctx, `geoly: downloading v${manifest.latest} for ${osName}/${arch}…`);
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
    const tmpNew = path.join(dir, `.geoly-new-${process.pid}`);
    const old = path.join(dir, `.geoly-old-${process.pid}`);
    fs.writeFileSync(tmpNew, bytes, { mode: 0o755 });
    try {
      fs.renameSync(binPath, old);
      fs.renameSync(tmpNew, binPath);
      fs.rm(old, () => undefined); // Windows may hold the running image; best-effort
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
    printResult(ctx, { upgraded: true, from: VERSION, to: manifest.latest, path: binPath });
    return 0;
  }
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

/** Placeholder referenced by docs; kept here so the import graph stays honest. */
export const UPGRADE_TMP_PREFIX = path.join(os.tmpdir(), 'geoly-upgrade');
