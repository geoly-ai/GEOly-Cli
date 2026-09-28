/**
 * `geoly upgrade` — manifest-driven self-update (no package manager).
 * Reads the release manifest, downloads the entry matching this os/arch,
 * verifies its sha256, then atomically swaps the running binary.
 *
 * `--auto` (hidden) is the detached background variant started once a day by any command
 * (see src/selfupdate.ts): silent, lock-guarded, never fails loudly, leaves a marker the next
 * interactive run reports.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { printResult, status } from '../output.js';
import {
  acquireUpdateLock,
  fetchManifest,
  installRelease,
  isCompiledInstall,
  writeAutoUpdateMarker,
} from '../selfupdate.js';
import { VERSION } from '../version.js';
import { isNewer } from '../updatecheck.js';
import { hostsWithSkill, installSkill, loadSkillBundle } from '../skills.js';
import { GeolyCommand } from './base.js';

export class UpgradeCommand extends GeolyCommand {
  static paths = [['upgrade']];
  static usage = Command.Usage({
    category: 'Setup',
    description: 'Update the CLI binary to the latest release, and refresh the skill in hosts that have it.',
    details:
      'Released binaries also update themselves in the background, at most once a day. ' +
      'Set GEOLY_NO_AUTO_UPDATE=1 to turn that off (it is always off in CI).',
  });

  auto = Option.Boolean('--auto', false, { hidden: true });

  protected async run(ctx: Ctx): Promise<number> {
    if (this.auto) return runAuto(ctx);

    if (!isCompiledInstall()) {
      throw new GeolyError('usage_error', 'This is not a compiled install — upgrade is only for released binaries', {
        hint: 'Development checkouts update via git; installed binaries via `geoly upgrade`.',
      });
    }

    const manifest = await fetchManifest(15_000);
    if (!isNewer(manifest.latest!, VERSION)) {
      const skills = await refreshInstalledSkills(ctx);
      printResult(ctx, { upToDate: true, version: VERSION, skills });
      return 0;
    }
    const installed = await installRelease(manifest, (msg) => status(ctx, msg));
    const skills = await refreshInstalledSkills(ctx);
    printResult(ctx, { upgraded: true, from: VERSION, to: installed.to, path: installed.path, skills });
    return 0;
  }
}

/**
 * Background update: one process at a time (lock), no output (stdio is detached anyway),
 * always exit 0 — a failed attempt simply retries on the next daily check.
 */
async function runAuto(ctx: Ctx): Promise<number> {
  if (!isCompiledInstall()) return 0;
  const release = acquireUpdateLock();
  if (!release) return 0;
  try {
    const manifest = await fetchManifest(15_000);
    if (!isNewer(manifest.latest!, VERSION)) return 0;
    const installed = await installRelease(manifest);
    writeAutoUpdateMarker({ from: VERSION, to: installed.to, at: new Date().toISOString() });
    await refreshInstalledSkills({ ...ctx, quiet: true }).catch(() => undefined);
  } catch {
    /* best-effort */
  } finally {
    release();
  }
  return 0;
}

/**
 * Hosts that already carry the skill get the current copy rewritten in place, so a CLI
 * upgrade never leaves an agent reading an older SKILL.md than the server expects.
 * Hosts without it are left alone — that is `geoly init`'s decision, not ours.
 */
async function refreshInstalledSkills(ctx: Ctx): Promise<Array<{ host: string; version: string; previous: string | null }>> {
  const hosts = hostsWithSkill();
  if (!hosts.length) return [];
  const bundle = await loadSkillBundle(ctx);
  return hosts.map((host) => {
    const r = installSkill(host, bundle);
    status(ctx, `geoly: skill ${bundle.version} → ${host.label} (${r.previous ?? 'new'})`);
    return { host: host.id, version: bundle.version, previous: r.previous ?? null };
  });
}

/** Placeholder referenced by docs; kept here so the import graph stays honest. */
export const UPGRADE_TMP_PREFIX = path.join(os.tmpdir(), 'geoly-upgrade');
