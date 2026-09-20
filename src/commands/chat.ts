/**
 * `geoly` — the interactive session. This is the product; `geoly ask` is its
 * non-interactive twin for scripts.
 *
 * You type, the agent works, you see what it is doing. The loop, the transcript
 * and the memory are local (see loop.ts); only inference is remote.
 *
 * Channels follow the output contract even here: the answer goes to stdout, all
 * chrome — banner, tool progress, usage — goes to stderr. `geoly > notes.md`
 * therefore captures answers and nothing else.
 */
import * as readline from 'node:readline';
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError, asGeolyError } from '../errors.js';
import { AgentSession } from '../loop.js';
import { bottomRule, frameWidth, row, topRule } from '../frame.js';
import { memoryPath, readNotes } from '../memory.js';
import { isAmbiguousOrg, resolveAmbiguousOrg } from '../org-select.js';
import type { WriteApproval } from '../workspace.js';
import { reportError } from '../output.js';
import { MarkdownLite, Spinner, formatBytes, formatTokens, line, style } from '../ui.js';
import { VERSION } from '../version.js';
import { GeolyCommand } from './base.js';

/** 输入行本身就是框的左边：上框线在提问前画，回车后收口。 */
const PROMPT = `${style.dim('│')} ${style.cyan('❯')} `;

/** Slash commands, in the order they show in /help and in Tab completion. */
const SLASH_COMMANDS = ['/new', '/status', '/memory', '/memory edit', '/tools', '/help', '/exit'];

const HELP = `
  ${style.bold('Commands')}
    /new            start a fresh conversation (memory is kept)
    /status         what this session is: brand, model, workspace, usage so far
    /memory         show the notes the agent carries into every turn
    /memory edit    print the path of the memory file so you can open it
    /tools          how many tools this session exposes
    /help           this list
    /exit           leave (Ctrl-D also works)

  ${style.dim('Anything else is a question. Tab completes / commands. Ctrl-C interrupts a running turn.')}
`;

/** Running totals for /status and the exit line. */
interface SessionStats {
  turns: number;
  steps: number;
  tokens: number;
  startedAt: number;
}

export class ChatCommand extends GeolyCommand {
  static paths = [Command.Default, ['chat']];
  static usage = Command.Usage({
    category: 'Chat',
    description: 'Start an interactive session with the GEO agent.',
    examples: [
      ['Start a session', 'geoly'],
      ['Continue where you left off', 'geoly --continue'],
      ['Pin a brand', 'geoly --brand br_123'],
    ],
  });

  brand = Option.String('--brand', { description: 'Brand id to bind this session to' });
  locale = Option.String('--locale', { description: 'Answer language: zh | en' });
  continueSession = Option.Boolean('--continue,-c', false, {
    description: 'Resume the most recent session for this brand',
  });
  allowWrites = Option.Boolean('--allow-writes', false, {
    description: 'Approve file writes up front (required when stdin is piped)',
  });
  workspace = Option.String('--workspace', {
    description: 'Directory the agent may read and write (default: current directory)',
  });

  protected async run(ctx: Ctx): Promise<number> {
    if (this.locale && this.locale !== 'zh' && this.locale !== 'en') {
      throw new GeolyError('usage_error', `--locale must be zh or en, got: ${this.locale}`);
    }
    const locale = this.locale as 'zh' | 'en' | undefined;

    // Piped stdin (`echo "..." | geoly`) is a script, not a session: answer once and exit.
    if (!process.stdin.isTTY) {
      const piped = await readAll();
      if (!piped.trim()) throw new GeolyError('usage_error', 'No question on stdin');
      const session = await AgentSession.create(ctx, {
        brandId: this.brand,
        locale,
        workspaceRoot: this.workspace,
        // 非交互场景问不了人：要么事先授权，要么一律拒绝。
        approveWrite: async () => this.allowWrites,
      });
      await this.runTurn(ctx, session, piped.trim());
      return 0;
    }

    // 写入审批需要 readline，而 readline 又要在会话建好后才开；用一个可后填的钩子解耦。
    let askApproval: WriteApproval = async () => this.allowWrites;
    const spinner = new Spinner();
    const open = async (c: Ctx): Promise<AgentSession> => {
      spinner.start('connecting');
      try {
        return await AgentSession.create(c, {
          brandId: this.brand,
          locale,
          resume: this.continueSession,
          workspaceRoot: this.workspace,
          approveWrite: (p, bytes) => askApproval(p, bytes),
        });
      } finally {
        spinner.stop();
      }
    };

    let session: AgentSession;
    try {
      session = await open(ctx);
    } catch (err) {
      // 多组织 token 且未指定组织时，服务端只能回一串 org id;这里换成带名字的
      // 选择器，选完记进 profile，下次直接进会话。
      if (!isAmbiguousOrg(err)) throw err;
      const org = await resolveAmbiguousOrg(ctx, true);
      session = await open({ ...ctx, org });
    }

    this.banner(session);
    const stats: SessionStats = { turns: 0, steps: 0, tokens: 0, startedAt: Date.now() };

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      prompt: style.cyan(PROMPT),
      historySize: 200,
      // Tab on a `/` prefix completes the slash commands; anything else completes nothing
      // (a question is free text — we must not "complete" it into something the user did not type).
      completer: (partial: string) => {
        if (!partial.startsWith('/')) return [[], partial];
        const hits = SLASH_COMMANDS.filter((c) => c.startsWith(partial));
        return [hits.length ? hits : SLASH_COMMANDS, partial];
      },
    });

    // 一次会话里只问一次「以后都允许」：既不让人反复按 y，也不默认放行。
    let alwaysAllow = this.allowWrites;
    askApproval = async (relativePath, bytes) => {
      if (alwaysAllow) return true;
      const answer = (
        await prompt(
          rl,
          `  ${style.yellow('write')} ${relativePath} (${bytes} bytes) — allow? [y/N/a=always] `,
        )
      )?.trim().toLowerCase();
      if (answer === 'a' || answer === 'always') {
        alwaysAllow = true;
        return true;
      }
      return answer === 'y' || answer === 'yes';
    };

    let running: AbortController | undefined;
    let lastSigint = 0;
    rl.on('SIGINT', () => {
      if (running) {
        running.abort();
        return;
      }
      const now = Date.now();
      if (now - lastSigint < 2000) {
        rl.close();
        return;
      }
      lastSigint = now;
      line(style.dim('  (press Ctrl-C again to exit)'));
      rl.prompt();
    });

    for (;;) {
      // 输入区是一个会收口的框：提问前画上沿，回车后画下沿。readline 不接管渲染，
      // 所以下沿只能等提交后再画——换来的是任何宽度、任何换行都不会把框画坏。
      line(topRule());
      const input = await prompt(rl);
      if (input === undefined) break; // Ctrl-D
      line(bottomRule());
      const text = input.trim();
      if (!text) continue;

      if (text.startsWith('/')) {
        const done = this.slash(text, session, stats);
        if (done) break;
        continue;
      }

      running = new AbortController();
      try {
        const turn = await this.runTurn(ctx, session, text, running.signal);
        stats.turns += 1;
        stats.steps += turn.steps;
        stats.tokens += turn.tokens;
      } catch (err) {
        reportError(ctx, asGeolyError(err));
      } finally {
        running = undefined;
      }
    }

    rl.close();
    // Exit line: what this sitting cost, and how to come back to it.
    line();
    line(
      style.dim(
        `  ${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'} · ${stats.steps} steps · ` +
          `${formatTokens(stats.tokens)} tokens · ${formatDuration(Date.now() - stats.startedAt)}`,
      ),
    );
    line(style.dim(`  session ${session.id} · resume with geoly --continue`));
    return 0;
  }

  /** Opening lines: what you are talking to, and what it carries. */
  /**
   * Opening frame: the mark, then what this session actually is.
   *
   * Ordered by how often it matters. The brand is the one thing you must not get wrong
   * (every answer and every credit is attributed to it), so it leads and is the only line
   * that is not dimmed. Model and tool counts answer "what am I talking to". The workspace
   * is a safety fact — the agent can read and write there — so it is stated, shortened to
   * `~` because the absolute path is noise in a home directory. Keys come last.
   */
  private banner(session: AgentSession): void {
    const notes = session.memoryCount;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const workspace =
      home && session.workspace.root.startsWith(home)
        ? `~${session.workspace.root.slice(home.length)}`
        : session.workspace.root;

    line();
    line(topRule(`GEOly ${style.dim(`v${VERSION}`)}`));
    line(row(style.cyan(session.profile.brand.name)));
    line(
      row(
        style.dim(
          `${session.profile.model} · ${session.toolCount}/${session.catalogSize} tools` +
            (notes > 0 ? ` · ${notes} note${notes === 1 ? '' : 's'}` : ''),
        ),
      ),
    );
    line(row(style.dim(workspace)));
    line(row(style.dim('/help · /status · Tab completes · Ctrl-C interrupts · Ctrl-D exits')));
    line(bottomRule());
    line();
  }

  /** `/status` — the banner's facts plus what has happened since. */
  private status(session: AgentSession, stats: SessionStats): void {
    const pairs: Array<[string, string]> = [
      ['brand', `${session.profile.brand.name} ${style.dim(session.profile.brand.id)}`],
      ['model', session.profile.model],
      ['tools', `${session.toolCount} loaded · ${session.catalogSize} reachable`],
      ['memory', `${session.memoryCount} note${session.memoryCount === 1 ? '' : 's'} · ${memoryPath(session.profile.brand.id)}`],
      ['workspace', session.workspace.root],
      ['session', `${session.id} · ${stats.turns} turn${stats.turns === 1 ? '' : 's'} · ${stats.steps} steps · ${formatTokens(stats.tokens)} tokens · ${formatDuration(Date.now() - stats.startedAt)}`],
    ];
    line();
    for (const [k, v] of pairs) line(`  ${style.dim(k.padEnd(10))} ${v}`);
    line();
  }

  /** Slash commands. Returns true when the session should end. */
  private slash(input: string, session: AgentSession, stats: SessionStats): boolean {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    switch (cmd) {
      case 'exit':
      case 'quit':
        return true;
      case 'status':
        this.status(session, stats);
        return false;
      case 'new':
        session.reset();
        line(style.dim('  new conversation'));
        return false;
      case 'tools':
        line(
          style.dim(
            `  ${session.toolCount} loaded · ${session.catalogSize} GEOly tools reachable via find_tools`,
          ),
        );
        return false;
      case 'memory': {
        if (rest[0] === 'edit') {
          line(style.dim(`  ${memoryPath(session.profile.brand.id)}`));
          return false;
        }
        const notes = readNotes(session.profile.brand.id);
        if (notes.length === 0) {
          line(style.dim('  no notes yet — the agent writes them as it learns'));
          return false;
        }
        for (const note of notes) {
          line(`  ${style.cyan(note.slug)}`);
          for (const l of note.content.split('\n')) line(`    ${style.dim(l)}`);
        }
        return false;
      }
      case 'help':
        line(HELP);
        return false;
      default:
        line(style.dim(`  unknown command: /${cmd} — /help for the list`));
        return false;
    }
  }

  /**
   * Render one turn. The spinner carries the "what is it doing right now"
   * signal: it shows the tool being called, so a 40s query does not look like
   * a hang, and it disappears the moment real text starts arriving.
   */
  private async runTurn(
    ctx: Ctx,
    session: AgentSession,
    question: string,
    signal?: AbortSignal,
  ): Promise<{ steps: number; tokens: number }> {
    const spinner = new Spinner();
    const quiet = ctx.quiet;
    // Interactive turns can be interrupted; say so where the eye is (piped stdin cannot).
    if (process.stdin.isTTY) spinner.hint = 'Ctrl-C to interrupt';
    if (!quiet) spinner.start('thinking');
    const startedAt = Date.now();
    const md = new MarkdownLite();
    let wroteText = false;
    let pending = '';
    let result = { steps: 0, tokens: 0 };
    // 未以换行结尾的残句必须在下一个「非文字事件」前吐出来，否则它会被工具行
    // 插队到后面，读者看到的顺序和实际发生的顺序不一致（stub 实测）。
    const flushPending = () => {
      if (!pending) return;
      process.stdout.write(`${md.line(pending)}\n`);
      pending = '';
    };
    // The answer marker (`⏺`) is chrome, so it goes to stderr — but only when stdout is the same
    // terminal; when the answer is being piped to a file the marker would just be a stray glyph.
    const answerMarker = () => {
      if (!quiet && process.stdout.isTTY) process.stderr.write(`${style.cyan('⏺')} `);
    };

    for await (const event of session.run(question, signal)) {
      switch (event.type) {
        case 'step':
          if (!quiet && !wroteText) spinner.update(`thinking · step ${event.n}`);
          break;
        case 'plan': {
          if (quiet) break;
          flushPending();
          spinner.stop();
          for (const item of event.items) {
            const mark =
              item.status === 'done'
                ? style.green('✔')
                : item.status === 'running'
                  ? style.cyan('▸')
                  : style.dim('◻');
            line(`  ${mark} ${item.status === 'done' ? style.dim(item.title) : item.title}`);
          }
          spinner.start('thinking');
          break;
        }
        case 'compact':
          if (quiet) break;
          spinner.stop();
          line(
            style.dim(
              `  ⤳ compacted ${event.droppedMessages} messages · ` +
                `${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens`,
            ),
          );
          spinner.start('thinking');
          break;
        case 'text': {
          if (!wroteText) {
            spinner.stop();
            if (!quiet) line();
            answerMarker();
            wroteText = true;
          }
          // Style only complete lines; a fragment could be half a heading.
          pending += event.text;
          const parts = pending.split('\n');
          pending = parts.pop() ?? '';
          for (const l of parts) process.stdout.write(`${md.line(l)}\n`);
          break;
        }
        case 'tool':
          if (quiet) break;
          flushPending();
          if (event.phase === 'call') {
            // The call line goes up the moment it starts (Claude Code's `⏺ Tool(args)`): a 40s
            // query then reads as "it is running this", not "it hung". The result line closes it.
            spinner.stop();
            line(`${style.green('⏺')} ${style.bold(event.name)}${event.args ? style.dim(`(${event.args})`) : ''}`);
            spinner.start(event.name);
            wroteText = false;
          } else {
            spinner.stop();
            const secs = event.ms ? `${(event.ms / 1000).toFixed(1)}s` : '';
            line(
              event.phase === 'error'
                ? `  ${style.dim('⎿')} ${style.red('✗')} ${style.dim(event.message ?? 'failed')}`
                : `  ${style.dim('⎿')} ${style.dim([secs, event.bytes !== undefined ? formatBytes(event.bytes) : ''].filter(Boolean).join(' · '))}`,
            );
            spinner.start('thinking');
          }
          break;
        case 'done': {
          flushPending();
          spinner.stop();
          result = { steps: event.steps, tokens: event.turnTokens };
          if (quiet) break;
          const note =
            event.stopped === 'budget'
              ? ' · step budget reached'
              : event.stopped === 'interrupted'
                ? ' · interrupted'
                : '';
          line();
          line(
            style.dim(
              `  ${event.steps} ${event.steps === 1 ? 'step' : 'steps'} · ${formatTokens(event.turnTokens)} tokens · ${formatDuration(Date.now() - startedAt)}${note}`,
            ),
          );
          line();
          break;
        }
      }
    }
    return result;
  }
}

/** `8.2s` / `1m 12s` / `1h 03m` — durations the way a person reads them. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** One line of input; undefined on Ctrl-D. */
function prompt(rl: readline.Interface, label = style.cyan(PROMPT)): Promise<string | undefined> {
  return new Promise((resolve) => {
    rl.question(label, (answer) => resolve(answer));
    rl.once('close', () => resolve(undefined));
  });
}

/** Read piped stdin to the end. */
async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
