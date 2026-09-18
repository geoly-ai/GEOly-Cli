/**
 * `geoly credits` — both credit pools at a glance, before starting something expensive.
 *
 * Reads the free `get_quota` tool (the same numbers the settings page shows): MCP Credits pay
 * for data tool calls, AI Credits pay for hosted agent inference (`geoly run`). The two pools
 * never borrow from each other, which is exactly why they are shown side by side.
 */
import { Command } from 'clipanion';
import { Ctx } from '../context.js';
import { McpClient, unwrapToolResult } from '../mcp.js';
import { printResult, printText } from '../output.js';
import { GeolyCommand } from './base.js';

interface Pool {
  quota_limit?: number;
  used?: number;
  remaining?: number;
  resets_at?: string;
  available?: boolean;
}

interface OrgQuota extends Pool {
  org_id: string;
  plan?: string;
  ai_credits?: Pool;
  note?: string;
}

export class CreditsCommand extends GeolyCommand {
  static paths = [['credits']];
  static usage = Command.Usage({
    category: 'Agent',
    description: 'Show remaining MCP Credits (tool calls) and AI Credits (geoly run) for your organization(s).',
    examples: [
      ['Both pools', 'geoly credits'],
      ['One organization, machine-readable', 'geoly credits --org org_123 --output json'],
    ],
  });

  protected async run(ctx: Ctx): Promise<number> {
    const client = new McpClient(ctx);
    const raw = unwrapToolResult('get_quota', await client.callTool('get_quota', {})) as {
      organizations?: OrgQuota[];
      pricing_summary?: unknown;
    };
    const orgs = raw.organizations ?? [];
    if (ctx.output === 'raw') {
      printText(orgs.map(renderOrg).join('\n\n') || 'No organizations visible to this token.');
      return 0;
    }
    printResult(ctx, { organizations: orgs });
    return 0;
  }
}

/** Human rendering: one block per organization, two lines per pool. -1 = unlimited. */
function renderOrg(o: OrgQuota): string {
  const lines = [`${o.org_id}${o.plan ? ` (${o.plan})` : ''}`];
  lines.push(`  MCP credits : ${renderPool(o)}`);
  lines.push(`  AI credits  : ${o.ai_credits ? renderPool(o.ai_credits) : 'n/a'}`);
  if (o.note) lines.push(`  note: ${o.note}`);
  return lines.join('\n');
}

function renderPool(p: Pool): string {
  if (p.available === false) return 'n/a';
  if (p.quota_limit === undefined) return 'n/a';
  if (p.quota_limit < 0) return `unlimited (used ${p.used ?? 0})`;
  const resets = p.resets_at ? ` · resets ${p.resets_at.slice(0, 10)}` : '';
  return `${p.remaining ?? 0} / ${p.quota_limit} remaining (used ${p.used ?? 0})${resets}`;
}
