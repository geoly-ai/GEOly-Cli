/**
 * Workspace — the agent's hands.
 *
 * Memory (memory.ts) is what the agent *knows*; the workspace is what it can
 * *make*: reports, exports, notes. This is the piece that turns a chat into a
 * worker, and it is also the first place the agent touches something that isn't
 * ours, so the rules are narrow on purpose:
 *
 * - every path is resolved and must stay inside the workspace root (the
 *   directory you launched from, or `--workspace`);
 * - writes are gated by an approval callback the UI owns — in a session you are
 *   asked, in a script you must pass `--allow-writes`;
 * - reads are allowed inside the root without asking, and always bounded.
 *
 * A file also keeps large output *out of the context window*: the tool result
 * is "wrote 42KB to report.md", not the 42KB.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Bound what one read can pull into the model's context. */
const MAX_READ_BYTES = 64_000;
const MAX_LIST_ENTRIES = 200;
/** A single write is a report or an export, not a disk image. */
const MAX_WRITE_BYTES = 4_000_000;

export type WriteApproval = (relativePath: string, bytes: number) => Promise<boolean>;

export interface PlanItem {
  title: string;
  status: 'pending' | 'running' | 'done';
}

export class Workspace {
  private plan: PlanItem[] = [];

  constructor(
    readonly root: string,
    private readonly approveWrite: WriteApproval,
  ) {}

  /** Current plan, for the UI to render after an `update_plan` call. */
  get currentPlan(): PlanItem[] {
    return this.plan;
  }

  /**
   * Resolve a model-supplied path inside the workspace.
   * Returns undefined when it escapes — symlinks included, since we compare the
   * real path of the root against the resolved target.
   */
  private resolve(input: string): string | undefined {
    if (typeof input !== 'string' || !input.trim()) return undefined;
    const target = path.resolve(this.root, input);
    const rootReal = fs.existsSync(this.root) ? fs.realpathSync(this.root) : this.root;
    const targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target;
    const rel = path.relative(rootReal, targetReal);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return target;
  }

  private rel(absolute: string): string {
    return path.relative(this.root, absolute).replace(/\\/g, '/') || '.';
  }

  /** Write a file. Returns the line the model sees — including refusals. */
  async write(input: { path?: string; content?: string }): Promise<string> {
    const target = this.resolve(input.path ?? '');
    if (!target) return `error: path must stay inside the workspace (${this.root})`;
    const content = input.content ?? '';
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      return `error: ${bytes} bytes exceeds the ${MAX_WRITE_BYTES} byte limit for one write`;
    }
    const relative = this.rel(target);
    if (!(await this.approveWrite(relative, bytes))) {
      return `error: the user declined the write to ${relative}`;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    } catch (err) {
      return `error: could not write ${relative}: ${(err as Error).message}`;
    }
    return `wrote ${relative} (${bytes} bytes)`;
  }

  /** Read a file from the workspace, bounded so one read cannot flood the context. */
  read(input: { path?: string }): string {
    const target = this.resolve(input.path ?? '');
    if (!target) return `error: path must stay inside the workspace (${this.root})`;
    let content: string;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch (err) {
      return `error: could not read ${this.rel(target)}: ${(err as Error).message}`;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
      return `${content.slice(0, MAX_READ_BYTES)}\n…[truncated; file is larger than ${MAX_READ_BYTES} bytes]`;
    }
    return content;
  }

  /** Shallow directory listing, so the agent can see what it already produced. */
  list(input: { path?: string }): string {
    const target = this.resolve(input.path ?? '.');
    if (!target) return `error: path must stay inside the workspace (${this.root})`;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err) {
      return `error: could not list ${this.rel(target)}: ${(err as Error).message}`;
    }
    const rows = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = 0;
      try {
        size = fs.statSync(path.join(target, e.name)).size;
      } catch {
        // unreadable entry — still worth listing by name
      }
      return `${e.name} (${size} bytes)`;
    });
    const more = entries.length > MAX_LIST_ENTRIES ? `\n…${entries.length - MAX_LIST_ENTRIES} more` : '';
    return rows.length > 0 ? rows.join('\n') + more : '(empty)';
  }

  /**
   * Replace the plan. The agent decides what the steps are and when they are
   * done — this only gives the work a shape the user can watch, it does not
   * prescribe any workflow.
   */
  updatePlan(input: { items?: unknown }): string {
    if (!Array.isArray(input.items)) return 'error: items must be an array';
    const items: PlanItem[] = [];
    for (const raw of input.items.slice(0, 20)) {
      const item = raw as { title?: unknown; status?: unknown };
      const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 120) : '';
      if (!title) continue;
      const status =
        item?.status === 'running' || item?.status === 'done' ? item.status : 'pending';
      items.push({ title, status });
    }
    if (items.length === 0) return 'error: no valid items';
    this.plan = items;
    const done = items.filter((i) => i.status === 'done').length;
    return `plan updated (${done}/${items.length} done)`;
  }
}

/** OpenAI function schemas for the workspace tools. */
export const WORKSPACE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        'Write a file into the user working directory — reports, exports, notes, anything you ' +
        'produced that should outlive this session. Prefer this over pasting long output into ' +
        'the reply: the file keeps the detail, the reply keeps the point. The user is asked to ' +
        'approve the first write.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. "geo-report.md" or "exports/citations.csv"' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read a file from the user working directory — an earlier report of yours, their notes, ' +
        'a sitemap or content file they want analysed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files in the user working directory (or a subdirectory of it).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative directory, default ".".' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description:
        'Publish or revise your plan for a multi-step task so the user can follow along. ' +
        'You decide the steps and when each is done; revise freely as you learn. ' +
        'Skip it for anything you can answer in one or two tool calls.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Ordered steps.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'running', 'done'] },
              },
              required: ['title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
];

export const WORKSPACE_TOOL_NAMES = new Set(
  WORKSPACE_TOOLS.map((t) => t.function.name),
);
