#!/usr/bin/env node
/**
 * GEOly CLI entry point.
 *
 * Two entrances, one credential: bare `geoly` opens the local chat agent for people; every
 * other command is the gh-style surface an agent host (Claude Code, Codex…) runs on the
 * user's behalf — `run` for the hosted GEO agent, `call` for raw data tools, `init` to teach
 * the host how to use all of it.
 */
import { Builtins, Cli } from 'clipanion';
import { EXIT } from './errors.js';
import { AskCommand } from './commands/ask.js';
import { AuthLoginCommand, AuthLogoutCommand, AuthStatusCommand } from './commands/auth.js';
import { CallCommand } from './commands/call.js';
import { ChatCommand } from './commands/chat.js';
import { CompletionsCommand } from './commands/completions.js';
import { CreditsCommand } from './commands/credits.js';
import { InitCommand } from './commands/init.js';
import { RunCommand } from './commands/run.js';
import { RunsListCommand, RunsWaitCommand } from './commands/runs.js';
import { SchemaCommand, ToolsCommand } from './commands/tools.js';
import { UpgradeCommand } from './commands/upgrade.js';
import { WhoamiCommand } from './commands/whoami.js';
import { VERSION } from './version.js';

// Broken pipes (e.g. `geoly tools | head`) are a normal way to be consumed.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const cli = new Cli({
  binaryLabel: 'GEOly CLI — for people and their agents (https://www.geoly.ai)',
  binaryName: 'geoly',
  binaryVersion: VERSION,
  // Help is read by agents through a pipe as often as by people in a terminal: colour only
  // when stdout is a TTY and NO_COLOR is unset, so `geoly --help | cat` is plain text.
  enableColors: process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb',
});

// Chat (people)
cli.register(ChatCommand);
// Agent (hosted GEO agent)
cli.register(RunCommand);
cli.register(RunsWaitCommand);
cli.register(RunsListCommand);
cli.register(CreditsCommand);
cli.register(AskCommand);
// Data (raw tools)
cli.register(ToolsCommand);
cli.register(SchemaCommand);
cli.register(CallCommand);
cli.register(WhoamiCommand);
// Setup
cli.register(InitCommand);
cli.register(AuthLoginCommand);
cli.register(AuthStatusCommand);
cli.register(AuthLogoutCommand);
cli.register(UpgradeCommand);
cli.register(CompletionsCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

/**
 * Parse first, run second. clipanion's own handling of a bad command line — unknown flag,
 * missing positional, unknown subcommand — prints the usage to **stdout** with exit 1, which a
 * script reads as "success with odd output" and which ignores `--error-format json`. Every
 * error the CLI raises itself is a `usage_error` on stderr with exit 2; make these the same.
 */
const argv = process.argv.slice(2);
let command;
try {
  command = cli.process(argv);
} catch (err) {
  const raw = err instanceof Error ? err.message : String(err);
  // clipanion's message: one sentence, then the usage line(s) it thinks you meant.
  const [sentence, ...rest] = raw.split('\n');
  // Keep the command shape, drop the wall of optional flags — `--help` has those.
  const usageLines = rest
    .map((l) => l.trim())
    .filter((l) => l.startsWith('$ '))
    .map((l) => l.slice(2).replace(/\s*\[[^\]]*\]/g, '').trim());
  const message = (sentence ?? raw).replace(/\.$/, '');
  const hint = usageLines.length ? `Usage: ${usageLines.join(' | ')} — run it with --help for flags.` : 'See `geoly --help`.';
  const wantJson = argv.includes('--error-format=json') || argv[argv.indexOf('--error-format') + 1] === 'json';
  process.stderr.write(
    wantJson
      ? `${JSON.stringify({ kind: 'usage_error', message, hint })}\n`
      : `error[usage_error]: ${message}\n  hint: ${hint}\n`,
  );
  process.exit(EXIT.usage ?? 2);
}

cli.runExit(command);
