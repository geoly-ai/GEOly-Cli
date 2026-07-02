/** `geoly whoami` — resolved identity: auth mode, endpoint, server info, tool surface. */
import { Command } from 'clipanion';
import { Ctx } from '../context.js';
import { McpClient } from '../mcp.js';
import { loadCredentials } from '../oauth.js';
import { printResult } from '../output.js';
import { GeolyCommand } from './base.js';

export class WhoamiCommand extends GeolyCommand {
  static paths = [['whoami']];
  static usage = Command.Usage({
    description: 'Show who you are connected as and what the server exposes to you.',
  });

  protected async run(ctx: Ctx): Promise<number> {
    const client = new McpClient(ctx);
    const [init, tools] = await Promise.all([client.initialize(), client.listTools()]);
    const names = new Set(tools.map((t) => t.name));
    // Mode inference mirrors the server's discovery flow (SKILL.md):
    // list_organizations ⇒ multi-org; list_brands ⇒ multi-brand; else single.
    const mode = names.has('list_organizations') ? 'multi-org' : names.has('list_brands') ? 'multi-brand' : 'single';
    const creds = ctx.staticToken ? undefined : loadCredentials(ctx);
    printResult(ctx, {
      auth: ctx.staticToken ? 'static-token (read-only)' : 'oauth',
      profile: ctx.profile,
      endpoint: ctx.endpoint,
      org: ctx.org ?? null,
      tokenExpiresAt: creds?.tokens ? new Date(creds.tokens.expiresAt).toISOString() : null,
      server: init.serverInfo ?? null,
      mode,
      toolCount: tools.length,
      publicToolsEnabled: [...names].some((n) => n.startsWith('get_public_') || n === 'compare_public_brands'),
    });
    return 0;
  }
}
