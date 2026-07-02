/**
 * Output contract (CONTRACT.md): stdout carries result data only —
 * pretty JSON in a TTY, compact when piped. All status/progress/errors
 * go to stderr, human-readable by default or a stable JSON object with
 * `--error-format json`.
 */
import type { Ctx } from './context.js';
import { GeolyError } from './errors.js';

/** Print a result value to stdout (data channel). */
export function printResult(ctx: Ctx, value: unknown): void {
  if (typeof value === 'string' && ctx.output === 'raw') {
    process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
    return;
  }
  const pretty = process.stdout.isTTY === true;
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

/** Print plain text to stdout (for completions scripts, schemas printed raw, etc.). */
export function printText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Status line on stderr; silenced by -q. */
export function status(ctx: Ctx, message: string): void {
  if (ctx.quiet) return;
  process.stderr.write(`${message}\n`);
}

/** Warning on stderr; never silenced (agents need truncation/stale hints). */
export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Report an error on stderr in the configured format. Returns the exit code. */
export function reportError(ctx: Ctx, err: GeolyError): number {
  if (ctx.errorFormat === 'json') {
    process.stderr.write(`${JSON.stringify(err.toJSON())}\n`);
    return err.exitCode;
  }
  // Human format: What / Why / Hint.
  const lines: string[] = [`error[${err.kind}]: ${err.message}`];
  if (err.status !== undefined || err.tool !== undefined) {
    const parts: string[] = [];
    if (err.status !== undefined) parts.push(`status ${err.status}`);
    if (err.tool !== undefined) parts.push(`tool ${err.tool}`);
    lines.push(`  why: ${parts.join(', ')}`);
  }
  if (err.retryAfter !== undefined) lines.push(`  retry-after: ${err.retryAfter}s`);
  if (err.hint) lines.push(`  hint: ${err.hint}`);
  process.stderr.write(`${lines.join('\n')}\n`);
  return err.exitCode;
}
