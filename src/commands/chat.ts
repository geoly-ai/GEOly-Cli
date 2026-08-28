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
import { memoryPath, readNotes } from '../memory.js';
import { reportError } from '../output.js';
import { Spinner, formatTokens, line, style, styleLine } from '../ui.js';
import { GeolyCommand } from './base.js';

const PROMPT = '› ';

const HELP = `
  ${style.bold('Commands')}
    /new            start a fresh conversation (memory is kept)
    /memory         show the notes the agent carries into every turn
    /memory edit    print the path of the memory file so you can open it
    /tools          how many tools this session exposes
    /help           this list
    /exit           leave (Ctrl-D also works)

  ${style.dim('Anything else is a question. Ctrl-C interrupts a running turn.')}
`;

export class ChatCommand extends GeolyCommand {
  static paths = [Command.Default, ['chat']];
  static usage = Command.Usage({
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

  protected async run(ctx: Ctx): Promise<number> {
    if (this.locale && this.locale !== 'zh' && this.locale !== 'en') {
      throw new GeolyError('usage_error', `--locale must be zh or en, got: ${this.locale}`);
    }
    const locale = this.locale as 'zh' | 'en' | undefined;

    // Piped stdin (`echo "..." | geoly`) is a script, not a session: answer once and exit.
    if (!process.stdin.isTTY) {
      const piped = await readAll();
      if (!piped.trim()) throw new GeolyError('usage_error', 'No question on stdin');
      const session = await AgentSession.create(ctx, { brandId: this.brand, locale });
      await this.runTurn(ctx, session, piped.trim());
      return 0;
    }

    const spinner = new Spinner();
    spinner.start('connecting');
    let session: AgentSession;
    try {
      session = await AgentSession.create(ctx, {
        brandId: this.brand,
        locale,
        resume: this.continueSession,
      });
    } finally {
      spinner.stop();
    }

    this.banner(session);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      prompt: style.cyan(PROMPT),
      historySize: 200,
    });

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
      const input = await prompt(rl);
      if (input === undefined) break; // Ctrl-D
      const text = input.trim();
      if (!text) continue;

      if (text.startsWith('/')) {
        const done = this.slash(text, session);
        if (done) break;
        continue;
      }

      running = new AbortController();
      try {
        await this.runTurn(ctx, session, text, running.signal);
      } catch (err) {
        reportError(ctx, asGeolyError(err));
      } finally {
        running = undefined;
      }
    }

    rl.close();
    line(style.dim(`  session ${session.id}`));
    return 0;
  }

  /** Opening lines: what you are talking to, and what it carries. */
  private banner(session: AgentSession): void {
    const notes = session.memoryCount;
    line();
    line(`  ${style.bold('GEOly')} ${style.dim('— GEO agent')}`);
    line(
      `  ${style.dim(
        `${session.profile.brand.name} · ${session.profile.model} · ${session.toolCount} tools` +
          (notes > 0 ? ` · ${notes} memory note${notes === 1 ? '' : 's'}` : ''),
      )}`,
    );
    line(`  ${style.dim('/help for commands · Ctrl-C interrupts · Ctrl-D exits')}`);
    line();
  }

  /** Slash commands. Returns true when the session should end. */
  private slash(input: string, session: AgentSession): boolean {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    switch (cmd) {
      case 'exit':
      case 'quit':
        return true;
      case 'new':
        session.reset();
        line(style.dim('  new conversation'));
        return false;
      case 'tools':
        line(style.dim(`  ${session.toolCount} tools (read-only surface + remember)`));
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
  ): Promise<void> {
    const spinner = new Spinner();
    const quiet = ctx.quiet;
    if (!quiet) spinner.start('thinking');
    let wroteText = false;
    let pending = '';
    // 未以换行结尾的残句必须在下一个「非文字事件」前吐出来，否则它会被工具行
    // 插队到后面，读者看到的顺序和实际发生的顺序不一致（stub 实测）。
    const flushPending = () => {
      if (!pending) return;
      process.stdout.write(`${styleLine(pending)}\n`);
      pending = '';
    };

    for await (const event of session.run(question, signal)) {
      switch (event.type) {
        case 'step':
          if (!quiet && !wroteText) spinner.update(`thinking · step ${event.n}`);
          break;
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
            wroteText = true;
          }
          // Style only complete lines; a fragment could be half a heading.
          pending += event.text;
          const parts = pending.split('\n');
          pending = parts.pop() ?? '';
          for (const l of parts) process.stdout.write(`${styleLine(l)}\n`);
          break;
        }
        case 'tool':
          if (quiet) break;
          flushPending();
          if (event.phase === 'call') {
            spinner.update(event.name);
            if (!wroteText) spinner.start(event.name);
          } else {
            spinner.stop();
            const ms = event.ms ? ` ${style.dim(`${(event.ms / 1000).toFixed(1)}s`)}` : '';
            line(
              event.phase === 'error'
                ? `  ${style.red('✗')} ${event.name}${ms} ${style.dim(event.message ?? '')}`
                : `  ${style.green('⏺')} ${style.dim(event.name)}${ms}`,
            );
            spinner.start('thinking');
          }
          break;
        case 'done': {
          flushPending();
          spinner.stop();
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
              `  ${event.steps} ${event.steps === 1 ? 'step' : 'steps'} · ${formatTokens(event.turnTokens)} tokens${note}`,
            ),
          );
          line();
          break;
        }
      }
    }
  }
}

/** One line of input; undefined on Ctrl-D. */
function prompt(rl: readline.Interface): Promise<string | undefined> {
  return new Promise((resolve) => {
    rl.question(style.cyan(PROMPT), (answer) => resolve(answer));
    rl.once('close', () => resolve(undefined));
  });
}

/** Read piped stdin to the end. */
async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
