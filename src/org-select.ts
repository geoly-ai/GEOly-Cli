/**
 * Picking an organization when the token can reach several.
 *
 * The server answers an ambiguous request with a correct but unusable message: 33 raw
 * org ids and no names. That is fine for an agent — it can call `list_organizations` —
 * but a person staring at `borg_5GqGiyXMDYLtZd9funMXB (1 brand)` thirty-three times
 * cannot pick anything. So the CLI resolves it here instead of passing the wall of ids
 * through: fetch the names, let the user choose, and remember the choice.
 */
import * as readline from 'node:readline';
import type { Ctx } from './context.js';
import { GeolyError } from './errors.js';
import { McpClient } from './mcp.js';
import { saveDefaultOrg } from './config.js';
import { canPick, pickFromList } from './select.js';
import { style } from './ui.js';

export interface OrgOption {
  org_id: string;
  name: string;
  role?: string;
}

/** The server's wording for "you can reach several orgs and I can't tell which". */
export function isAmbiguousOrg(err: unknown): boolean {
  return (
    err instanceof GeolyError &&
    err.kind === 'usage_error' &&
    /spans multiple organizations/i.test(err.message)
  );
}

/** Ask the server which organizations this token can reach, with names. */
export async function listOrganizations(ctx: Ctx): Promise<OrgOption[]> {
  const client = new McpClient(ctx);
  const result = await client.callTool('list_organizations', {});
  // 工具面既可能给结构化结果，也可能只给一段 JSON 文本，两种都认
  let payload = result.structuredContent as { organizations?: OrgOption[] } | undefined;
  if (!payload?.organizations) {
    const text = result.content?.find((c) => typeof c.text === 'string')?.text;
    if (text) {
      try {
        payload = JSON.parse(text) as { organizations?: OrgOption[] };
      } catch {
        payload = undefined;
      }
    }
  }
  const orgs = payload?.organizations ?? [];
  return orgs.filter((o) => typeof o?.org_id === 'string');
}

/** `name (id)`, the form a human can actually act on. */
function label(o: OrgOption): string {
  return o.name ? `${o.name} ${style.dim(`(${o.org_id})`)}` : o.org_id;
}

/**
 * Non-interactive fallback: keep the failure, but make it answerable — names, and the
 * exact flag to add. Never prompt here; a piped or CI run has nobody to answer.
 */
export function ambiguousOrgError(orgs: OrgOption[]): GeolyError {
  const lines = orgs.map((o) => `  ${o.name || '(unnamed)'} — ${o.org_id}`).join('\n');
  return new GeolyError(
    'usage_error',
    `This token can reach ${orgs.length} organizations; pick one with --org.\n${lines}`,
    { status: 400, hint: 'Example: geoly --org <id>. Run `geoly` interactively to pick from a list.' },
  );
}

/**
 * Interactive picker. Returns the chosen org id and persists it as this profile's
 * default, so the next run needs no flag — the choice is the kind of thing a person
 * should make once, not once per command.
 */
export async function promptForOrg(
  ctx: Ctx,
  orgs: OrgOption[],
  /** Injected so the picker can be exercised without a TTY (scripts/verify-org-picker.mts). */
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): Promise<string> {
  if (orgs.length === 0) {
    throw new GeolyError('grant_missing', 'This token cannot reach any organization.');
  }
  if (orgs.length === 1) {
    const only = orgs[0] as OrgOption;
    saveDefaultOrg(ctx.profile, only.org_id);
    return only.org_id;
  }

  // 方向键选择器：33 条列表里让人「看到哪行就选哪行」，而不是把行号翻译成数字。
  // 管道 / CI 下进不了 raw 模式，回落到编号输入（下面那段）。
  if (canPick(io.input)) {
    const chosen = await pickFromList(
      orgs.map((o) => ({ value: o.org_id, label: o.name || o.org_id, detail: `(${o.org_id})` })),
      {
        title: 'Which organization?',
        footer: '↑↓ move · type to filter · enter select · esc cancel  (saved as this profile default; override with --org)',
        input: io.input,
        output: io.output,
      },
    );
    if (!chosen) throw new GeolyError('usage_error', 'No organization selected.', { hint: 'Pass --org <id> to skip the picker.' });
    saveDefaultOrg(ctx.profile, chosen);
    const picked = orgs.find((o) => o.org_id === chosen);
    io.output.write(style.dim(`  → ${picked?.name || chosen}

`));
    return chosen;
  }

  const rl = readline.createInterface({ input: io.input, output: io.output });
  const write = (text: string) => io.output.write(text);
  try {
    write(`\n${style.bold('Which organization?')}\n`);
    orgs.forEach((o, i) => {
      write(`  ${style.cyan(String(i + 1).padStart(2))}. ${label(o)}\n`);
    });
    write(style.dim('  (saved as this profile default; override any time with --org)\n\n'));

    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(style.cyan('  number > '), resolve);
      });
      const trimmed = answer.trim();
      if (!trimmed) continue;
      // 也接受直接粘 id：多组织用户常常已经知道要哪个
      const byId = orgs.find((o) => o.org_id === trimmed);
      const index = Number(trimmed);
      const chosen =
        byId ?? (Number.isInteger(index) && index >= 1 && index <= orgs.length ? orgs[index - 1] : undefined);
      if (!chosen) {
        write(style.dim(`  enter 1-${orgs.length}, or paste an org id\n`));
        continue;
      }
      saveDefaultOrg(ctx.profile, chosen.org_id);
      write(style.dim(`  → ${chosen.name || chosen.org_id}\n\n`));
      return chosen.org_id;
    }
  } finally {
    rl.close();
  }
}

/**
 * The whole recovery in one call: turn "ambiguous" into a usable organization.
 * Interactive sessions get a picker; everything else gets a named list and a flag to add.
 */
export async function resolveAmbiguousOrg(ctx: Ctx, interactive: boolean): Promise<string> {
  const orgs = await listOrganizations(ctx);
  if (!interactive) throw ambiguousOrgError(orgs);
  return promptForOrg(ctx, orgs);
}
