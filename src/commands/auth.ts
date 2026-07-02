/** `geoly auth login|status|logout` — explicit auth management (lazy auth makes login optional). */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { clearCredentials, loadCredentials, login } from '../oauth.js';
import { printResult, status } from '../output.js';
import { GeolyCommand } from './base.js';

export class AuthLoginCommand extends GeolyCommand {
  static paths = [['auth', 'login']];
  static usage = Command.Usage({
    description: 'Authorize this machine via the browser (OAuth). Optional — any command triggers this automatically when needed.',
  });

  noBrowser = Option.Boolean('--no-browser', false, { description: 'Print the authorization URL instead of opening a browser' });

  protected ctxInput() {
    return { ...super.ctxInput(), noBrowser: this.noBrowser };
  }

  protected async run(ctx: Ctx): Promise<number> {
    const tokens = await login(ctx);
    printResult(ctx, {
      authorized: true,
      profile: ctx.profile,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      scope: tokens.scope,
    });
    return 0;
  }
}

export class AuthStatusCommand extends GeolyCommand {
  static paths = [['auth', 'status']];
  static usage = Command.Usage({ description: 'Show the current credential state for this profile.' });

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

export class AuthLogoutCommand extends GeolyCommand {
  static paths = [['auth', 'logout']];
  static usage = Command.Usage({ description: 'Delete stored credentials for this profile.' });

  protected async run(ctx: Ctx): Promise<number> {
    clearCredentials(ctx);
    status(ctx, `geoly: credentials for profile "${ctx.profile}" removed`);
    printResult(ctx, { loggedOut: true, profile: ctx.profile });
    return 0;
  }
}
