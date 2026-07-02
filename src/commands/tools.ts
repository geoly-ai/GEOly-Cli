/** `geoly tools` / `geoly schema <tool>` — runtime discovery of the server tool surface. */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { McpClient, toolAccess } from '../mcp.js';
import { printResult, printText } from '../output.js';
import { GeolyCommand } from './base.js';

export class ToolsCommand extends GeolyCommand {
  static paths = [['tools']];
  static usage = Command.Usage({
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
        tools.map((t) => ({ name: t.name, title: firstLine(t.description), access: toolAccess(t.name) })),
      );
      return 0;
    }
    // Human view: aligned name + access + first description line.
    const width = Math.max(...tools.map((t) => t.name.length), 4);
    const lines = tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `${t.name.padEnd(width)}  ${toolAccess(t.name).padEnd(16)}  ${firstLine(t.description)}`);
    printText(lines.join('\n'));
    return 0;
  }
}

export class SchemaCommand extends GeolyCommand {
  static paths = [['schema']];
  static usage = Command.Usage({
    description: "Print one tool's full input schema and description.",
    examples: [['Inspect a tool', 'geoly schema get_brand_overview']],
  });

  tool = Option.String();

  protected async run(ctx: Ctx): Promise<number> {
    const tools = await new McpClient(ctx).listTools();
    const found = tools.find((t) => t.name === this.tool);
    if (!found) {
      throw new GeolyError('usage_error', `Unknown tool "${this.tool}"`, {
        hint: suggest(this.tool, tools.map((t) => t.name)),
      });
    }
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
