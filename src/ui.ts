/**
 * Terminal presentation primitives — zero dependencies.
 *
 * Everything here writes to **stderr**, never stdout: the output contract says
 * stdout is the data channel, and an interactive session must not corrupt it
 * for someone piping `geoly ask` in a script.
 *
 * Color is opt-out (NO_COLOR, non-TTY) rather than opt-in, so a real terminal
 * looks like a product and a pipe stays clean.
 */

const useColor =
  process.stderr.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function wrap(open: string, close: string) {
  return (text: string): string =>
    useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

export const style = {
  dim: wrap('2', '22'),
  bold: wrap('1', '22'),
  cyan: wrap('36', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  red: wrap('31', '39'),
  magenta: wrap('35', '39'),
};

/** Write a line to the status channel. */
export function line(text = ''): void {
  process.stderr.write(`${text}\n`);
}

/** Clear the current stderr line (used before replacing a spinner frame). */
function clearLine(): void {
  if (process.stderr.isTTY) process.stderr.write('\x1b[2K\r');
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A single-line spinner for the wait between "question sent" and "first token".
 * No-ops on a non-TTY so logs stay readable; `stop()` is idempotent.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label = '';
  private startedAt = 0;

  start(label: string): void {
    this.label = label;
    this.startedAt = Date.now();
    if (!process.stderr.isTTY || this.timer) return;
    this.timer = setInterval(() => {
      const seconds = Math.round((Date.now() - this.startedAt) / 1000);
      const frame = FRAMES[this.frame % FRAMES.length] ?? '.';
      this.frame += 1;
      clearLine();
      process.stderr.write(style.dim(`${frame} ${this.label} ${seconds}s`));
    }, 90);
    this.timer.unref?.();
  }

  /** Change the label without restarting the animation. */
  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    clearLine();
  }
}

/**
 * Very small markdown touch-up for streamed assistant text.
 *
 * Deliberately not a markdown renderer: the text arrives in fragments, so any
 * real parser would need buffering and would break mid-token. This only styles
 * whole lines that are unambiguous once a newline has arrived.
 */
export function styleLine(text: string): string {
  if (/^#{1,6}\s/.test(text)) return style.bold(text.replace(/^#{1,6}\s/, ''));
  if (/^\s*[-*]\s/.test(text)) return text.replace(/^(\s*)[-*]\s/, (_m, indent) => `${indent}${style.cyan('•')} `);
  return text;
}

/** Format a token count the way a terminal user reads it. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
