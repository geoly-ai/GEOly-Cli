/**
 * `geoly init` — the one command a new machine needs: sign in, then teach the agent hosts on
 * this machine (Claude Code, Codex, Cursor) how to use GEOly by installing the skill into
 * their global skills directories.
 *
 * Skills come from the live copy on app.geoly.ai (published on every app deploy) so what an
 * agent reads is never older than the server it talks to; the embedded copy is only used
 * offline. `geoly upgrade` refreshes the same directories, so hosts stay in step with the CLI.
 */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { ensureAccessToken, loadCredentials } from '../oauth.js';
import { printResult, status, warn } from '../output.js';
import { AGENT_HOSTS, AgentHost, InstallResult, detectHosts, installSkill, loadSkillBundle } from '../skills.js';
import { GeolyCommand } from './base.js';

export class InitCommand extends GeolyCommand {
  static paths = [['init']];
  static usage = Command.Usage({
    category: 'Setup',
    description: 'Sign in and install the GEOly skill into the agent hosts found on this machine.',
    details: `
      Detects Claude Code (~/.claude), Codex (~/.codex) and Cursor (~/.cursor) and writes the
      skill to each host's global skills directory. Add \`.geoly/\` to your project's .gitignore —
      \`geoly run\` drops receipts there.
    `,
    examples: [
      ['Sign in and install into every host found', 'geoly init'],
      ['Skills only (CI images, dotfiles)', 'geoly init --no-login'],
      ['Only one host', 'geoly init --agent codex'],
    ],
  });

  agent = Option.String('--agent', { description: `Install into one host only: ${AGENT_HOSTS.map((h) => h.id).join(' | ')}` });
  noLogin = Option.Boolean('--no-login', false, { description: 'Skip the sign-in step' });

  protected async run(ctx: Ctx): Promise<number> {
    const only = this.agent as AgentHost['id'] | undefined;
    if (only && !AGENT_HOSTS.some((h) => h.id === only)) {
      throw new GeolyError('usage_error', `--agent must be one of ${AGENT_HOSTS.map((h) => h.id).join(', ')}`);
    }

    // 1. Sign-in (lazy auth would do it on first use, but init is where a person expects it).
    let signedIn = false;
    if (!this.noLogin) {
      await ensureAccessToken(ctx);
      signedIn = true;
      status(ctx, `· signed in (profile "${ctx.profile}")`);
    } else if (!ctx.staticToken && !loadCredentials(ctx)?.tokens) {
      warn('geoly: not signed in — run `geoly auth login` before the first `geoly run`');
    }

    // 2. Skill bundle: live if reachable, embedded otherwise.
    const bundle = await loadSkillBundle(ctx);
    status(ctx, `· skill geoly-mcp ${bundle.version} (${bundle.source === 'live' ? 'from app.geoly.ai' : 'embedded copy — live bundle not reachable'})`);

    // 3. Hosts.
    const hosts = detectHosts(only);
    if (!hosts.length) {
      warn('geoly: no agent host found (looked for ~/.claude, ~/.codex, ~/.cursor) — nothing installed');
      printResult(ctx, { signedIn, skillVersion: bundle.version, skillSource: bundle.source, installed: [] });
      return 0;
    }
    const installed: InstallResult[] = [];
    for (const host of hosts) {
      const r = installSkill(host, bundle);
      installed.push(r);
      status(ctx, `· ${host.label}: ${r.dir}${r.previous ? ` (was ${r.previous})` : ''}`);
    }
    status(ctx, '· tip: add `.geoly/` to .gitignore — `geoly run` writes receipts there');
    printResult(ctx, {
      signedIn,
      skillVersion: bundle.version,
      skillSource: bundle.source,
      installed: installed.map((r) => ({ host: r.host.id, dir: r.dir, files: r.files, previous: r.previous ?? null })),
      next: 'geoly run "how visible is my brand this week?"',
    });
    return 0;
  }
}
