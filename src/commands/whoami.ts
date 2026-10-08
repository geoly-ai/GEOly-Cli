/** `geoly whoami` — resolved identity: auth mode, endpoint, server info, tool surface. */
import { Command } from 'clipanion';
import { Ctx } from '../context.js';
import { McpClient, WRITE_TOOLS } from '../mcp.js';
import { loadCredentials } from '../oauth.js';
import { printResult } from '../output.js';
import { GeolyCommand } from './base.js';

/**
 * The server registers the Grow-gated public / industry tools as one group (all or none — Grow+
 * plan AND the public read grant), so one member tells whether the group is on. It must be a
 * name only that group has: the old `get_public_` prefix test was true on every plan, because
 * the free source trio (`get_public_sources_overview`, `get_public_source_domain_detail`,
 * `get_public_source_brand_conduit`) is not Grow-gated (it only needs the source read grant, on
 * by default); and `compare_public_brands` is no longer listed since the 2026-09-29 consolidation
 * (the server still accepts it as a hidden MCP v1 name, but tools/list does not carry it).
 * `search_public_entities` is the group's entry point ("call first") on both the old and the
 * consolidated surface.
 */
const PUBLIC_GROUP_MARKER = 'search_public_entities';

export class WhoamiCommand extends GeolyCommand {
  static paths = [['whoami']];
  static usage = Command.Usage({
    category: 'Data',
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
      // GEOLY_TOKEN holds an API key whose permissions are set per key — `writeTools` below is
      // what the server actually granted it; the CLI does not assume read-only.
      auth: ctx.staticToken ? 'api-key' : 'oauth',
      profile: ctx.profile,
      endpoint: ctx.endpoint,
      org: ctx.org ?? null,
      tokenExpiresAt: creds?.tokens ? new Date(creds.tokens.expiresAt).toISOString() : null,
      server: init.serverInfo ?? null,
      mode,
      toolCount: tools.length,
      publicToolsEnabled: names.has(PUBLIC_GROUP_MARKER),
      // Write tools appear only when the grant covers them: an OAuth consent (single-org grant +
      // Write ticked) or an API key created with those write permissions.
      writeTools: [...names].filter((n) => WRITE_TOOLS.has(n)).sort(),
    });
    return 0;
  }
}
