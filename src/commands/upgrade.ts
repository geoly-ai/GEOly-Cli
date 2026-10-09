/**
 * `geoly upgrade` — manifest-driven self-update (no package manager).
 * Reads the release manifest, downloads the entry matching this os/arch,
 * verifies its sha256, then atomically swaps the running binary.
 *
 * `--auto` (hidden) is the detached background variant started once a day by any command
 * (see src/selfupdate.ts): silent, lock-guarded, never fails loudly, leaves a marker the next
 * interactive run reports. With no new binary it still brings the skill in hosts that have it
 * up to the published version (the skill changes with every app deploy, the binary does not).
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
import { VERSION, isNewer } from '../version.js';
import { InstallResult, hostsWithSkill, installSkill, loadSkillBundle, refreshStaleSkills } from '../skills.js';
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
    await backgroundUpdate({ ...ctx, quiet: true });
  } catch {
    /* best-effort */
  } finally {
    release();
  }
  return 0;
}

export interface SkillRefresh {
  host: string;
  /** The version the host has now (the kept one when a newer copy was left in place). */
  version: string;
  previous: string | null;
  kept?: boolean;
}

/**
 * One pass of the daily background update (the body of `upgrade --auto`, minus the lock; exported
 * for scripts/verify-tool-surface.mts).
 *
 * - A newer binary: swap it in, leave the marker, then rewrite the skill in every host that has it
 *   (same as before).
 * - No newer binary — or the release manifest / download could not be had (github.com and
 *   app.geoly.ai fail independently): still compare the host skills with the published one and
 *   rewrite only the hosts that are behind. Before this the pass returned early and the skill
 *   only moved with a binary release, so a tool-surface change on the server (renamed / removed
 *   tools) sat unseen in agent hosts until the next CLI version.
 *
 * Time stays bounded: release manifest 15 s, then skill manifest 5 s and — only when a host is
 * behind — the skill zip 15 s; a no-change day costs two small requests.
 */
export async function backgroundUpdate(ctx: Ctx): Promise<{ binary?: { from: string; to: string }; skills: SkillRefresh[] }> {
  let manifest: Awaited<ReturnType<typeof fetchManifest>> | undefined;
  try {
    manifest = await fetchManifest(15_000);
  } catch {
    manifest = undefined; // release channel unreachable — the skill check below does not depend on it
  }
  if (manifest && isNewer(manifest.latest!, VERSION)) {
    try {
      const installed = await installRelease(manifest);
      writeAutoUpdateMarker({ from: VERSION, to: installed.to, at: new Date().toISOString() });
      const skills = await refreshInstalledSkills(ctx).catch(() => []);
      return { binary: { from: VERSION, to: installed.to }, skills };
    } catch {
      /* the swap failed and is retried tomorrow; still keep the skill current */
    }
  }
  const refreshed = await refreshStaleSkills(ctx);
  return { skills: refreshed.map(toSkillRefresh) };
}

/**
 * Hosts that already carry the skill get the current copy rewritten in place, so a CLI
 * upgrade never leaves an agent reading an older SKILL.md than the server expects.
 * Hosts without it are left alone — that is `geoly init`'s decision, not ours.
 */
async function refreshInstalledSkills(ctx: Ctx): Promise<SkillRefresh[]> {
  const hosts = hostsWithSkill();
  if (!hosts.length) return [];
  const bundle = await loadSkillBundle(ctx);
  return hosts.map((host) => {
    const r = installSkill(host, bundle);
    // A kept host was already explained on stderr by installSkill.
    if (!r.kept) status(ctx, `geoly: skill ${bundle.version} → ${host.label} (${r.previous ?? 'new'})`);
    return toSkillRefresh(r);
  });
}

/** One host's outcome in the `skills` array printed by `geoly upgrade`. */
function toSkillRefresh(r: InstallResult): SkillRefresh {
  return { host: r.host.id, version: r.version, previous: r.previous ?? null, ...(r.kept ? { kept: true } : {}) };
}

/** Placeholder referenced by docs; kept here so the import graph stays honest. */
export const UPGRADE_TMP_PREFIX = path.join(os.tmpdir(), 'geoly-upgrade');
