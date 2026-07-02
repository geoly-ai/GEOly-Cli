#!/usr/bin/env node
/** GEOly CLI entry point — registers the stable v0 command set. */
import { Builtins, Cli } from 'clipanion';
import { AuthLoginCommand, AuthLogoutCommand, AuthStatusCommand } from './commands/auth.js';
import { CallCommand } from './commands/call.js';
import { CompletionsCommand } from './commands/completions.js';
import { SchemaCommand, ToolsCommand } from './commands/tools.js';
import { UpgradeCommand } from './commands/upgrade.js';
import { WhoamiCommand } from './commands/whoami.js';
import { VERSION } from './version.js';

// Broken pipes (e.g. `geoly tools | head`) are a normal way to be consumed.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const cli = new Cli({
  binaryLabel: 'GEOly CLI — built for agents (https://www.geoly.ai)',
  binaryName: 'geoly',
  binaryVersion: VERSION,
});

cli.register(AuthLoginCommand);
cli.register(AuthStatusCommand);
cli.register(AuthLogoutCommand);
cli.register(WhoamiCommand);
cli.register(ToolsCommand);
cli.register(SchemaCommand);
cli.register(CallCommand);
cli.register(UpgradeCommand);
cli.register(CompletionsCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(process.argv.slice(2));
