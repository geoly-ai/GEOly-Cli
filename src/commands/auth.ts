/** `geoly auth login|status|token|logout` — explicit auth management (lazy auth makes login optional). */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { clearCredentials, completeRemoteLogin, ensureAccessToken, loadCredentials, login, shouldUseRemoteFlow, startRemoteLogin } from '../oauth.js';
import { printResult, status } from '../output.js';
import { GeolyCommand } from './base.js';

export class AuthLoginCommand extends GeolyCommand {
  static paths = [['auth', 'login']];
  static usage = Command.Usage({
    category: 'Setup',
    description: 'Sign in via the browser (OAuth). Optional — any command triggers this automatically when needed.',
    details: `
      Three ways in, picked in this order:

      1. Browser round-trip (default): opens the browser, signs in, returns to this terminal.
      2. Paste-code (\`--remote\`, auto-selected over SSH / in CI / without a display): prints a
         sign-in URL to open in any browser; the page shows a code to paste back with \`--code\`.
      3. Servers and CI: set GEOLY_TOKEN instead of signing in.
    `,
    examples: [
      ['Sign in on this machine', 'geoly auth login'],
      ['No local browser — start the paste-code flow', 'geoly auth login --remote'],
      ['…then finish it with the code from the page', 'geoly auth login --code 7Hk2…'],
    ],
  });

  noBrowser = Option.Boolean('--no-browser', false, { description: 'Print the authorization URL instead of opening a browser (still listens on loopback)' });
  remote = Option.Boolean('--remote', false, { description: 'Paste-code sign-in for machines without a browser: print a URL, finish with --code' });
  code = Option.String('--code', { description: 'Finish a paste-code sign-in with the code shown on the page' });

  protected ctxInput() {
    return { ...super.ctxInput(), noBrowser: this.noBrowser, remote: this.remote };
  }

  protected async run(ctx: Ctx): Promise<number> {
    if (this.code !== undefined) {
      // Same charset the hosted page enforces (RFC 3986 unreserved): anything else is not a code.
      if (!/^[A-Za-z0-9._~-]{8,512}$/.test(this.code.trim())) {
        throw new GeolyError('usage_error', '--code does not look like an authorization code', {
          hint: 'Copy it from the page exactly; it contains only letters, digits, . _ ~ -',
        });
      }
      const tokens = await completeRemoteLogin(ctx, this.code);
      printResult(ctx, this.authorizedResult(ctx, tokens.expiresAt, tokens.scope));
      return 0;
    }
    if (shouldUseRemoteFlow(ctx)) {
      const started = await startRemoteLogin(ctx);
      if (process.stdin.isTTY && process.stderr.isTTY) {
        // A person is here: take the code right away instead of making them run a second command.
        const code = await promptLine('Paste the code: ');
        if (code) {
          const tokens = await completeRemoteLogin(ctx, code);
          printResult(ctx, this.authorizedResult(ctx, tokens.expiresAt, tokens.scope));
          return 0;
        }
      }
      printResult(ctx, {
        authorized: false,
        pending: true,
        profile: ctx.profile,
        url: started.authorizeUrl,
        next: 'geoly auth login --code <code>',
      });
      return 0;
    }
    const tokens = await login(ctx);
    printResult(ctx, this.authorizedResult(ctx, tokens.expiresAt, tokens.scope));
    return 0;
  }

  private authorizedResult(ctx: Ctx, expiresAt: number, scope?: string) {
    return { authorized: true, profile: ctx.profile, expiresAt: new Date(expiresAt).toISOString(), scope };
  }
}

/** One line from an interactive terminal; empty string when the user just hits Enter. */
function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(buf.slice(0, nl).replace(/\r$/, '').trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export class AuthStatusCommand extends GeolyCommand {
  static paths = [['auth', 'status']];
  static usage = Command.Usage({ category: 'Setup', description: 'Show the current credential state for this profile.' });

  protected async run(ctx: Ctx): Promise<number> {
    if (ctx.staticToken) {
      printResult(ctx, { mode: 'static-token', source: 'GEOLY_TOKEN', readOnly: true, endpoint: ctx.endpoint });
      return 0;
    }
    const creds = loadCredentials(ctx);
    if (!creds?.tokens) {
      printResult(ctx, { mode: 'oauth', authorized: false, profile: ctx.profile, endpoint: ctx.endpoint });
      return 0;
    }
    printResult(ctx, {
      mode: 'oauth',
      authorized: creds.tokens.expiresAt > Date.now(),
      profile: ctx.profile,
      endpoint: ctx.endpoint,
      expiresAt: new Date(creds.tokens.expiresAt).toISOString(),
      scope: creds.tokens.scope,
    });
    return 0;
  }
}

/**
 * `geoly auth token` — print the current access token to stdout so scripts and
 * your own services can call the GEOly HTTP endpoints (Agent API, MCP) with
 * `Authorization: Bearer <token>`. Runs the normal sign-in first if there is no
 * valid token (same rules as any other command). The token is a secret.
 */
export class AuthTokenCommand extends GeolyCommand {
  static paths = [['auth', 'token']];
  static usage = Command.Usage({
    category: 'Setup',
    description: 'Print the current access token (for Authorization: Bearer on the HTTP API). Treat it as a secret.',
    examples: [
      ['Call the Agent API with curl', 'curl -H "Authorization: Bearer $(geoly auth token)" https://app.geoly.ai/api/agent/runs'],
    ],
  });

  protected async run(ctx: Ctx): Promise<number> {
    const token = await ensureAccessToken(ctx);
    // 只把 token 本身写 stdout（便于 $(geoly auth token) 取值）；提示走 stderr
    process.stdout.write(`${token}
`);
    if (process.stdout.isTTY) {
      status(ctx, 'geoly: this is a secret bearer token — do not paste it into chats, logs or repos');
    }
    return 0;
  }
}

export class AuthLogoutCommand extends GeolyCommand {
  static paths = [['auth', 'logout']];
  static usage = Command.Usage({ category: 'Setup', description: 'Delete stored credentials for this profile.' });

  protected async run(ctx: Ctx): Promise<number> {
    clearCredentials(ctx);
    status(ctx, `geoly: credentials for profile "${ctx.profile}" removed`);
    printResult(ctx, { loggedOut: true, profile: ctx.profile });
    return 0;
  }
}
