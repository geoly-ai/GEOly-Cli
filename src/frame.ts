/**
 * The box language the session is drawn in.
 *
 * A note on why there is no picture of the logo here: the GEOly mark is an abstract knot
 * of thin strokes, and every terminal rasterization of it — 12 rows through 24 — came out
 * as a blob. A mark you cannot read is worse than no mark, so the brand shows up as a
 * hexagon glyph in the header rule instead, and the boxes carry the rest of the identity.
 */
import { style } from './ui.js';

/** Hexagon — the silhouette the real mark is built on, and the one shape that survives. */
export const GLYPH = '⬡';

/** Colour escapes must not count toward width, or every framed line comes out crooked. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function visibleWidth(text: string): number {
  return text.replace(ANSI, '').length;
}

/**
 * Box width: follow the terminal, but stay inside a range where the frame still helps.
 * Too narrow and the text wraps out of the box; too wide and the eye loses the right edge.
 */
export function frameWidth(): number {
  const columns = process.stderr.columns ?? 80;
  return Math.max(40, Math.min(columns - 2, 76));
}

/** `╭─ ⬡ GEOly ─────╮` — a titled top rule. */
export function topRule(title?: string, width = frameWidth()): string {
  if (!title) return style.dim(`╭${'─'.repeat(width - 2)}╮`);
  const label = ` ${GLYPH} ${title} `;
  const fill = Math.max(0, width - 3 - label.length);
  return style.dim('╭─') + style.bold(label) + style.dim(`${'─'.repeat(fill)}╮`);
}

export function bottomRule(width = frameWidth()): string {
  return style.dim(`╰${'─'.repeat(width - 2)}╯`);
}

/** One boxed line, padded so the right edge lines up regardless of colour codes. */
export function row(text: string, width = frameWidth()): string {
  const pad = Math.max(0, width - 4 - visibleWidth(text));
  return `${style.dim('│')} ${text}${' '.repeat(pad)} ${style.dim('│')}`;
}
