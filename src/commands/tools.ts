/** `geoly tools` / `geoly schema <tool>` — runtime discovery of the server tool surface. */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { McpClient, toolAccess } from '../mcp.js';
import { printResult, printText } from '../output.js';
import { removedToolAdvice } from '../removed-tools.js';
import { GeolyCommand } from './base.js';

export class ToolsCommand extends GeolyCommand {
  static paths = [['tools']];
  static usage = Command.Usage({
    category: 'Data',
    description: 'List the tools currently exposed to your account (plan/mode aware).',
    details: 'Tool names come from the server at runtime — probe here before calling.',
  });

  json = Option.Boolean('--json', false, { description: 'Machine-readable [{name,title,access}]' });
  refresh = Option.Boolean('--refresh', false, { description: 'Bypass the 60s cache' });

  protected async run(ctx: Ctx): Promise<number> {
    const tools = await new McpClient(ctx).listTools(this.refresh);
    if (this.json) {
      printResult(
        ctx,
        tools.map((t) => ({
          name: t.name,
          title: firstLine(t.description),
          access: toolAccess(t.name),
          // A server may keep retired names registered as forwarding aliases and mark them
          // `[DEPRECATED → parent]`; agents scripting against --json should skip those. (The
          // 2026-09-29 consolidation unlisted the old names instead — the server answers them as
          // hidden names until 2026-11-30 and then removes them; see removed-tools.ts.)
          ...(isDeprecated(t.description) ? { deprecated: true } : {}),
        })),
      );
      return 0;
    }
    // Human view: aligned name + access + first description line.
    const width = Math.max(...tools.map((t) => t.name.length), 4);
    const lines = tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `${t.name.padEnd(width)}  ${(isDeprecated(t.description) ? 'deprecated' : toolAccess(t.name)).padEnd(16)}  ${firstLine(t.description)}`);
    printText(lines.join('\n'));
    return 0;
  }
}

/** Server convention for retired-but-still-registered tools (geoly-app tool-deprecation.ts). */
function isDeprecated(description?: string): boolean {
  return (description ?? '').startsWith('[DEPRECATED');
}

export class SchemaCommand extends GeolyCommand {
  static paths = [['schema']];
  static usage = Command.Usage({
    category: 'Data',
    description: "Print one tool's full input schema and description.",
    examples: [['Inspect a tool', 'geoly schema get_brand_overview']],
  });

  tool = Option.String();

  protected async run(ctx: Ctx): Promise<number> {
    const tools = await new McpClient(ctx).listTools();
    const found = tools.find((t) => t.name === this.tool);
    if (!found) throw unknownToolError(this.tool, tools.map((t) => t.name));
    printResult(ctx, {
      name: found.name,
      access: toolAccess(found.name),
      description: found.description,
      inputSchema: found.inputSchema,
    });
    return 0;
  }
}

function firstLine(text?: string): string {
  return (text ?? '').split('\n')[0]?.slice(0, 100) ?? '';
}

/**
 * The usage error for a name the server does not list. A pre-0.7.0 name unlisted by the 2026-09-29
 * consolidation (removed-tools.ts) says which tool absorbed it and how to call that instead —
 * that table wins over the typo guess, which would otherwise offer a near-miss old name's
 * siblings. Anything else gets the nearest-name suggestion as before. `names` = this token's tool
 * list, when known (it lets the hint flag a replacement the token does not have either).
 */
export function unknownToolError(input: string, names?: string[]): GeolyError {
  const removed = removedToolAdvice(input, 'cli', names ? new Set(names) : undefined);
  if (removed) return new GeolyError('usage_error', removed.message, { hint: removed.hint });
  return new GeolyError('usage_error', `Unknown tool "${input}"`, { hint: suggest(input, names ?? []) });
}

/** Small typo helper: nearest names by shared-prefix/substring heuristic. */
export function suggest(input: string, names: string[]): string {
  const needle = input.toLowerCase().replace(/-/g, '_');
  const close = names
    .filter((n) => n.includes(needle) || needle.includes(n) || sharedPrefix(n, needle) >= 6)
    .slice(0, 3);
  return close.length > 0
    ? `Did you mean: ${close.join(', ')}? Run \`geoly tools\` to list everything.`
    : 'Run `geoly tools` to list available tools.';
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
