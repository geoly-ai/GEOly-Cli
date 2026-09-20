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

cli.runExit(process.argv.slice(2));
