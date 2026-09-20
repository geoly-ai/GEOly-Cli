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
/** Answer text goes to stdout; `geoly > notes.md` must get plain text even while stderr is a terminal. */
const useColorOut =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function wrap(open: string, close: string, enabled = useColor) {
  return (text: string): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
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

/** Same palette, gated on stdout being a terminal — for the answer channel only. */
const out = {
  dim: wrap('2', '22', useColorOut),
  bold: wrap('1', '22', useColorOut),
  cyan: wrap('36', '39', useColorOut),
};

/** Write a line to the status channel. */
export function line(text = ''): void {
  process.stderr.write(`${text}\n`);
}

/** Clear the current stderr line (used before replacing a spinner frame). */
function clearLine(): void {
  if (process.stderr.isTTY) process.stderr.write('\x1b[2K\r');
}

/** The star that breathes while the model thinks (the Claude Code idiom — instantly readable as "working"). */
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/**
 * A single-line spinner for the wait between "question sent" and "first token".
 * No-ops on a non-TTY so logs stay readable; `stop()` is idempotent.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label = '';
  private startedAt = 0;
  /** Trailing hint such as "Ctrl-C to interrupt"; shown dim after the elapsed time. */
  hint = '';

  start(label: string): void {
    this.label = label;
    this.startedAt = Date.now();
    if (!process.stderr.isTTY || this.timer) return;
    this.timer = setInterval(() => {
      const seconds = Math.round((Date.now() - this.startedAt) / 1000);
      const frame = FRAMES[this.frame % FRAMES.length] ?? '.';
      this.frame += 1;
      clearLine();
      process.stderr.write(
        `${style.cyan(frame)} ${style.dim(`${this.label} · ${seconds}s`)}${this.hint ? style.dim(` · ${this.hint}`) : ''}`,
      );
    }, 120);
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
 * Deliberately not a markdown renderer: the text arrives in fragments, so any real parser
 * would need buffering and would break mid-token. This styles whole lines only, once a
 * newline has arrived: headings, bullets, numbered items, fenced code (state carried
 * across lines), and the two inline forms that are unambiguous on a complete line —
 * `**bold**` and `` `code` ``. Colour is gated on stdout being a terminal.
 */
export class MarkdownLite {
  private inFence = false;

  line(text: string): string {
    if (/^\s*```/.test(text)) {
      this.inFence = !this.inFence;
      return out.dim(text.replace(/^(\s*)```(\w+)?.*$/, (_m, indent, lang) => `${indent}${lang ? `── ${lang} ──` : '──'}`));
    }
    if (this.inFence) return out.dim(`  ${text}`);
    if (/^#{1,6}\s/.test(text)) return out.bold(inline(text.replace(/^#{1,6}\s/, '')));
    if (/^\s*[-*]\s/.test(text)) return text.replace(/^(\s*)[-*]\s(.*)$/, (_m, indent, rest) => `${indent}${out.cyan('•')} ${inline(rest)}`);
    if (/^\s*\d+\.\s/.test(text)) return text.replace(/^(\s*)(\d+\.)\s(.*)$/, (_m, indent, num, rest) => `${indent}${out.cyan(num)} ${inline(rest)}`);
    if (/^\s*>\s?/.test(text)) return out.dim(text.replace(/^(\s*)>\s?/, '$1│ '));
    return inline(text);
  }
}

/** `**bold**` and `` `code` `` inside one complete line. */
function inline(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => out.bold(t))
    .replace(/`([^`\n]+)`/g, (_m, t) => out.cyan(t));
}

/** Kept for callers that style a single line with no fence state (e.g. `ask`). */
export function styleLine(text: string): string {
  return new MarkdownLite().line(text);
}

/** `3.4 KB` / `812 B` — result sizes next to tool lines. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a token count the way a terminal user reads it. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
