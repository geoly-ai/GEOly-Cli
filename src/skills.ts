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
import { SKILL_BUNDLE_FILES, SKILL_BUNDLE_VERSION } from './skill-bundle.generated.js';
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
  if (manifest?.version) {
    try {
      const res = await fetch(skillUrl(ctx, 'zip'), { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (!manifest.zip?.sha256 || manifest.zip.sha256 === sha) {
          const files = readZip(buf)
            .filter((e) => e.path.startsWith(`${SKILL_NAME}/`))
            .map((e) => ({ rel: e.path.slice(SKILL_NAME.length + 1), data: e.data }));
          if (files.some((f) => f.rel === 'SKILL.md')) return { version: manifest.version, source: 'live', files };
        }
      }
    } catch {
      // fall through to the embedded copy
    }
  }
  return {
    version: SKILL_BUNDLE_VERSION,
    source: 'embedded',
    files: SKILL_BUNDLE_FILES.map((f) => ({ rel: f.path.slice(SKILL_NAME.length + 1), data: Buffer.from(f.base64, 'base64') })),
  };
}

export interface InstallResult {
  host: AgentHost;
  dir: string;
  files: number;
  /** The version that was there before, if any (from SKILL.md frontmatter). */
  previous?: string;
}

/** Write the bundle into one host's skills dir. Replaces the folder's contents; never touches siblings. */
export function installSkill(host: AgentHost, bundle: SkillBundle, home = os.homedir()): InstallResult {
  const dir = path.join(home, host.skillsDir, SKILL_NAME);
  const previous = installedVersion(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of bundle.files) {
    const target = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  return { host, dir, files: bundle.files.length, previous };
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
