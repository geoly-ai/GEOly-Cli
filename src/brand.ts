/**
 * The GEOly mark, for terminals.
 *
 * Generated from `public/logo.png` by downsampling to a 12×12 grid and mapping each
 * character cell to the two pixels it covers (`▀ ▄ █`) — so it is the real mark, not a
 * hand-drawn approximation of it. 12×12 is the smallest size where the hexagon and the
 * stroke through it both survive; below that it turns to mush.
 */
export const MARK = [
  '  █▀▀▀▀▀█',
  ' █ ▄▄▄▄█▀█▄',
  '█  █  █  ▄ █',
  '█ ▀█  ▀▀█  █',
  ' █  █▀▀▀▀ █',
  '  █▄▄█▄▄▄█',
];

/** Width the mark occupies, so callers can align text beside it. */
export const MARK_WIDTH = Math.max(...MARK.map((l) => l.length));

/**
 * Measuring width has to ignore colour escapes, or every styled line counts a dozen
 * characters too long and the narrow-terminal check misfires.
 *
 * The pattern is assembled at runtime: a literal ESC in source is both hard to read and
 * easy to lose — the first version of this line was written without it, which silently
 * under-counted each escape sequence by one character.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Lay the mark beside a block of text.
 *
 * The two columns are padded to the same height so the block reads as one unit however
 * many info lines the caller has.
 */
export function withMark(lines: string[], gap = 3): string[] {
  // 窄终端里图标会把信息挤到换行，那比没有图标难看得多 —— 放不下就不放。
  const columns = process.stderr.columns ?? 80;
  const longest = Math.max(...lines.map((l) => stripAnsi(l).length));
  if (columns < MARK_WIDTH + gap + longest + 2) {
    return lines.map((l) => `  ${l}`);
  }

  const height = Math.max(MARK.length, lines.length);
  // 文字比图标少时垂直居中，视觉重心才不会偏上
  const padTop = Math.max(0, Math.floor((MARK.length - lines.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const mark = (MARK[i] ?? '').padEnd(MARK_WIDTH);
    const textIndex = i - padTop;
    const text = textIndex >= 0 ? (lines[textIndex] ?? '') : '';
    out.push(` ${mark}${' '.repeat(gap)}${text}`.trimEnd());
  }
  return out;
}
