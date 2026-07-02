/**
 * Shared command base: global flags, context construction, and the
 * error-to-exit-code bridge. Every command's `run()` result is its exit code.
 */
import { Command, Option } from 'clipanion';
import { Ctx, CtxInput, makeCtx } from '../context.js';
import { asGeolyError } from '../errors.js';
import { reportError } from '../output.js';
import { maybeNotifyUpdate } from '../updatecheck.js';

export abstract class GeolyCommand extends Command {
  profile = Option.String('--profile', 'default', { description: 'Credential profile (multi-account)' });
  org = Option.String('--org', { description: 'Narrow the session to one organization id' });
  output = Option.String('--output', 'json', { description: 'json | raw' });
  errorFormat = Option.String('--error-format', 'human', { description: 'human | json' });
  quiet = Option.Boolean('-q,--quiet', false, { description: 'Suppress status messages on stderr' });
  timeout = Option.String('--timeout', { description: 'Request timeout in seconds (max 120)' });
  noAutoAuth = Option.Boolean('--no-auto-auth', false, { description: 'Fail fast instead of opening a browser' });

  /** Subclasses implement run(); execute() adds ctx + contract error handling. */
  protected abstract run(ctx: Ctx): Promise<number>;

  protected ctxInput(): CtxInput {
    return {
      profile: this.profile,
      org: this.org,
      output: this.output,
      errorFormat: this.errorFormat,
      quiet: this.quiet,
      timeout: this.timeout,
      noAutoAuth: this.noAutoAuth,
    };
  }

  async execute(): Promise<number> {
    let ctx: Ctx;
    try {
      ctx = makeCtx(this.ctxInput());
    } catch (err) {
      // Context errors have no ctx yet — report with defaults.
      return reportError(makeSafeCtx(), asGeolyError(err));
    }
    try {
      const code = await this.run(ctx);
      await maybeNotifyUpdate();
      return code;
    } catch (err) {
      return reportError(ctx, asGeolyError(err));
    }
  }
}

/** Minimal fallback ctx used only when option validation itself failed. */
function makeSafeCtx(): Ctx {
  return {
    endpoint: '',
    profile: 'default',
    output: 'json',
    errorFormat: 'human',
    quiet: false,
    timeoutMs: 30_000,
    noAutoAuth: true,
    noBrowser: true,
  };
}
