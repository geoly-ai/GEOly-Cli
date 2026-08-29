/**
 * Arrow-key list picker.
 *
 * Typing a number out of a list of thirty-three is the kind of thing that reads as
 * "unfinished" the moment you see it — you scan the list, you already know which row you
 * want, and then you have to translate it into a number. So: move with the arrows, type to
 * narrow, Enter to take it.
 *
 * Two constraints shape the implementation. The list is taller than the terminal (33 orgs),
 * so it renders a scrolling window rather than the whole thing. And it must degrade: raw
 * mode does not exist on a pipe or in CI, and the caller still needs an answer there, so
 * `pickFromList` reports that it cannot run and the caller falls back.
 */
import * as readline from 'node:readline';
import { style } from './ui.js';

export interface PickItem {
  /** Returned to the caller when this row is chosen. */
  value: string;
  /** Primary text. */
  label: string;
  /** Dimmed suffix — the id, a role, whatever disambiguates. */
  detail?: string;
}

/** stdin in raw mode is the whole feature; without it we cannot read arrow keys. */
type RawInput = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
  isTTY?: boolean;
};

/** How many rows of the list are on screen at once. */
const WINDOW = 12;

export function canPick(input: RawInput): boolean {
  return typeof input.setRawMode === 'function';
}

/**
 * Render the list and let the user move through it.
 *
 * Returns the chosen value, or `undefined` if the user backed out (Esc / Ctrl-C) — a
 * cancel is a normal outcome here, not an error, and the caller decides what it means.
 */
export function pickFromList(
  items: PickItem[],
  opts: {
    title: string;
    footer?: string;
    input?: RawInput;
    output?: NodeJS.WritableStream;
  },
): Promise<string | undefined> {
  const input = opts.input ?? (process.stdin as RawInput);
  const output = opts.output ?? process.stderr;

  return new Promise((resolve) => {
    let filter = '';
    let cursor = 0;
    let top = 0;
    let drawn = 0;

    const matches = (): PickItem[] => {
      if (!filter) return items;
      const needle = filter.toLowerCase();
      return items.filter(
        (i) =>
          i.label.toLowerCase().includes(needle) ||
          (i.detail ?? '').toLowerCase().includes(needle),
      );
    };

    const write = (s: string) => output.write(s);

    /** Redraw in place: jump back over what we drew last time, then paint again. */
    const render = () => {
      if (drawn > 0) write(`\x1b[${drawn}A`);
      write('\x1b[0J'); // clear from cursor to end of screen
      const list = matches();
      if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
      if (cursor < top) top = cursor;
      if (cursor >= top + WINDOW) top = cursor - WINDOW + 1;
      const end = Math.min(list.length, top + WINDOW);

      const lines: string[] = [];
      lines.push(style.bold(opts.title) + (filter ? style.dim(`  /${filter}`) : ''));
      if (list.length === 0) {
        lines.push(style.dim('  no match'));
      }
      for (let i = top; i < end; i++) {
        const item = list[i] as PickItem;
        const selected = i === cursor;
        const marker = selected ? style.cyan('❯') : ' ';
        const label = selected ? style.cyan(item.label) : item.label;
        const detail = item.detail ? ` ${style.dim(item.detail)}` : '';
        lines.push(`${marker} ${label}${detail}`);
      }
      // 有滚动时明确告诉用户上下还有内容，否则 33 选 12 会以为就这些
      const hidden = list.length - end + top;
      if (list.length > WINDOW) {
        lines.push(style.dim(`  ${cursor + 1}/${list.length}${hidden > 0 ? ' ↓' : ''}`));
      }
      lines.push(style.dim(opts.footer ?? '↑↓ move · type to filter · enter select · esc cancel'));

      write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    const cleanup = () => {
      input.removeListener('keypress', onKey);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      input.pause();
      // 收起整个列表，只留调用方要打印的结论
      if (drawn > 0) write(`\x1b[${drawn}A\x1b[0J`);
    };

    const finish = (value: string | undefined) => {
      cleanup();
      resolve(value);
    };

    function onKey(chunk: string, key: readline.Key | undefined): void {
      const list = matches();
      const name = key?.name;
      if (key?.ctrl && name === 'c') return finish(undefined);
      if (name === 'escape') return finish(undefined);
      if (name === 'return' || name === 'enter') {
        const chosen = list[cursor];
        return finish(chosen?.value);
      }
      if (name === 'up') cursor = cursor > 0 ? cursor - 1 : Math.max(0, list.length - 1);
      else if (name === 'down') cursor = cursor < list.length - 1 ? cursor + 1 : 0;
      else if (name === 'pageup') cursor = Math.max(0, cursor - WINDOW);
      else if (name === 'pagedown') cursor = Math.min(list.length - 1, cursor + WINDOW);
      else if (name === 'home') cursor = 0;
      else if (name === 'end') cursor = Math.max(0, list.length - 1);
      else if (name === 'backspace') {
        filter = filter.slice(0, -1);
        cursor = 0;
      } else if (chunk && !key?.ctrl && !key?.meta && chunk >= ' ' && chunk.length === 1) {
        filter += chunk;
        cursor = 0;
      } else {
        return; // 其它按键忽略，不重绘
      }
      render();
    }

    readline.emitKeypressEvents(input as NodeJS.ReadableStream);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    render();
  });
}
