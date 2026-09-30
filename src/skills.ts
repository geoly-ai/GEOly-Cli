/**
 * The GEOly skill (SKILL.md + references) is how an agent host learns to use this CLI and the
 * MCP tools. Its source of truth lives in the app repo; the app publishes it at
 * `/skills/geoly-mcp.{json,zip}` on every deploy. This module fetches that live copy, falls
 * back to the bundle embedded at build time when offline, and writes it into the skill
 * directories of whichever agent hosts are installed on this machine.
 *
 * Nothing here needs npm or `npx skills add` — most of our users are on Windows without them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Ctx } from './context.js';
import { warn } from './output.js';
import { SKILL_BUNDLE_FILES, SKILL_BUNDLE_VERSION } from './skill-bundle.generated.js';
import { isNewer } from './version.js';
import { readZip } from './zip.js';

export const SKILL_NAME = 'geoly-mcp';

export interface SkillFile {
  /** Path inside the skill folder, e.g. `SKILL.md`, `references/tools-catalog.md`. */
  rel: string;
  data: Buffer;
}

export interface SkillBundle {
  version: string;
  source: 'live' | 'embedded';
  files: SkillFile[];
}

/** An agent host we know how to install into: its marker dir tells us it is present. */
export interface AgentHost {
  id: 'claude-code' | 'codex' | 'cursor';
  label: string;
  /** Presence marker under the home directory. */
  marker: string;
  /** Global skills directory under the home directory. */
  skillsDir: string;
}

export const AGENT_HOSTS: ReadonlyArray<AgentHost> = [
  { id: 'claude-code', label: 'Claude Code', marker: '.claude', skillsDir: path.join('.claude', 'skills') },
  { id: 'codex', label: 'Codex', marker: '.codex', skillsDir: path.join('.codex', 'skills') },
  { id: 'cursor', label: 'Cursor', marker: '.cursor', skillsDir: path.join('.cursor', 'skills') },
];

/** Hosts whose marker directory exists in $HOME (or all of them when `only` names one). */
export function detectHosts(only?: AgentHost['id'], home = os.homedir()): AgentHost[] {
  if (only) return AGENT_HOSTS.filter((h) => h.id === only);
  return AGENT_HOSTS.filter((h) => {
    try {
      return fs.statSync(path.join(home, h.marker)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Same-origin sibling of the MCP endpoint: `https://app.geoly.ai/skills/geoly-mcp.zip`. */
function skillUrl(ctx: Ctx, file: string): string {
  return `${new URL(ctx.endpoint).origin}/skills/${SKILL_NAME}.${file}`;
}

interface LiveManifest {
  version?: string;
  zip?: { sha256?: string; bytes?: number };
}

/** The published manifest (small). Undefined when unreachable. */
export async function fetchLiveManifest(ctx: Ctx, timeoutMs = 5_000): Promise<LiveManifest | undefined> {
  try {
    const res = await fetch(skillUrl(ctx, 'json'), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as LiveManifest;
  } catch {
    return undefined;
  }
}

/**
 * Prefer the live bundle (verified against the manifest's sha256); fall back to the embedded
 * one. Returns which one was used so the caller can say so.
 */
export async function loadSkillBundle(ctx: Ctx): Promise<SkillBundle> {
  const manifest = await fetchLiveManifest(ctx);
  const live = manifest ? await fetchLiveBundle(ctx, manifest) : undefined;
  return (
    live ?? {
      version: SKILL_BUNDLE_VERSION,
      source: 'embedded',
      files: SKILL_BUNDLE_FILES.map((f) => ({ rel: f.path.slice(SKILL_NAME.length + 1), data: Buffer.from(f.base64, 'base64') })),
    }
  );
}

/**
 * The live zip named by `manifest`, sha256-checked against it (15 s budget). Undefined when it
 * cannot be fetched or does not verify — never the embedded copy: callers that must not
 * downgrade a host (the background refresh) need to tell "live" from "nothing".
 */
async function fetchLiveBundle(ctx: Ctx, manifest: LiveManifest): Promise<SkillBundle | undefined> {
  if (!manifest.version) return undefined;
  try {
    const res = await fetch(skillUrl(ctx, 'zip'), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (manifest.zip?.sha256 && manifest.zip.sha256 !== sha) return undefined;
    const files = readZip(buf)
      .filter((e) => e.path.startsWith(`${SKILL_NAME}/`))
      .map((e) => ({ rel: e.path.slice(SKILL_NAME.length + 1), data: e.data }));
    return files.some((f) => f.rel === 'SKILL.md') ? { version: manifest.version, source: 'live', files } : undefined;
  } catch {
    return undefined;
  }
}

export interface InstallResult {
  host: AgentHost;
  dir: string;
  files: number;
  /** The version the host has after this call (the bundle's, or the kept one). */
  version: string;
  /** The version that was there before, if any (from SKILL.md frontmatter). */
  previous?: string;
  /**
   * True when nothing was written because the host already has a newer skill than the embedded
   * fallback on offer (`previous` is what stays installed; `files` is 0).
   */
  kept?: boolean;
}

/**
 * Write the bundle into one host's skills dir. Replaces the folder's contents; never touches siblings.
 *
 * Downgrade guard: the embedded copy is frozen when this binary was built, while the host may
 * already carry a newer skill from the live bundle (an online `geoly init`, a newer CLI, the
 * background refresh). An offline install or refresh would silently roll the agent back to
 * tool names the server has since removed — so an embedded bundle older than what is installed
 * is not written; the newer copy stays and stderr says why. A live bundle is the server's own
 * current copy and always replaces what is there.
 */
export function installSkill(host: AgentHost, bundle: SkillBundle, home = os.homedir()): InstallResult {
  const dir = path.join(home, host.skillsDir, SKILL_NAME);
  const previous = installedVersion(dir);
  if (bundle.source === 'embedded' && previous !== undefined && isNewer(previous, bundle.version)) {
    warn(
      `geoly: kept skill ${previous} in ${host.label} (${dir}) — it is newer than this CLI's embedded ${bundle.version}, ` +
        'and the live copy on app.geoly.ai was not reachable',
    );
    return { host, dir, files: 0, version: previous, previous, kept: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of bundle.files) {
    const target = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  return { host, dir, files: bundle.files.length, version: bundle.version, previous };
}

/** Version in an installed SKILL.md, if there is one. */
export function installedVersion(dir: string): string | undefined {
  try {
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    return /^\s*version:\s*"([^"]+)"/m.exec(skill)?.[1];
  } catch {
    return undefined;
  }
}

/** Hosts that already have the skill installed (used by `upgrade` to refresh them in place). */
export function hostsWithSkill(home = os.homedir()): AgentHost[] {
  return AGENT_HOSTS.filter((h) => installedVersion(path.join(home, h.skillsDir, SKILL_NAME)) !== undefined);
}

/**
 * Background skill refresh — what the daily `geoly upgrade --auto` does when there is no new
 * binary. The skill moves with every app deploy (new tool names, removed ones), far more often
 * than the CLI, so waiting for the next binary left hosts reading a stale SKILL.md for weeks.
 *
 * Bounded and quiet by construction: one manifest request (5 s) decides; only when a host is
 * behind is the zip fetched (15 s). Only hosts that already have the skill are touched (a new
 * install is `geoly init`'s decision), only the ones behind the live version are rewritten, and
 * the embedded copy is never used here — it can only be older than what the live bundle gave
 * those hosts. Never throws; an unreachable server just means "try again tomorrow".
 */
export async function refreshStaleSkills(ctx: Ctx, home = os.homedir()): Promise<InstallResult[]> {
  try {
    const hosts = hostsWithSkill(home);
    if (!hosts.length) return [];
    const manifest = await fetchLiveManifest(ctx);
    const live = manifest?.version;
    if (!manifest || !live) return [];
    const stale = hosts.filter((h) => {
      const v = installedVersion(path.join(home, h.skillsDir, SKILL_NAME));
      return v !== undefined && isNewer(live, v);
    });
    if (!stale.length) return [];
    const bundle = await fetchLiveBundle(ctx, manifest);
    if (!bundle) return [];
    return stale.map((h) => installSkill(h, bundle, home));
  } catch {
    return [];
  }
}
