/** `geoly completions <shell>` — static completion scripts for the stable command set. */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { printText } from '../output.js';
import { GeolyCommand } from './base.js';

const SUBCOMMANDS = ['auth', 'whoami', 'tools', 'schema', 'call', 'upgrade', 'completions'];

export class CompletionsCommand extends GeolyCommand {
  static paths = [['completions']];
  static usage = Command.Usage({
    description: 'Print a shell completion script (bash or zsh).',
    examples: [['Install for bash', 'geoly completions bash >> ~/.bashrc']],
  });

  shell = Option.String();

  protected async run(_ctx: Ctx): Promise<number> {
    if (this.shell === 'bash') {
      printText(
        [
          `_geoly_completions() {`,
          `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
          `  if [ "\$COMP_CWORD" -eq 1 ]; then`,
          `    COMPREPLY=( \$(compgen -W "${SUBCOMMANDS.join(' ')}" -- "\$cur") )`,
          `  elif [ "\${COMP_WORDS[1]}" = "auth" ] && [ "\$COMP_CWORD" -eq 2 ]; then`,
          `    COMPREPLY=( \$(compgen -W "login status logout" -- "\$cur") )`,
          `  fi`,
          `}`,
          `complete -F _geoly_completions geoly`,
        ].join('\n'),
      );
      return 0;
    }
    if (this.shell === 'zsh') {
      printText(
        [
          `#compdef geoly`,
          `_geoly() {`,
          `  local -a subcmds`,
          `  subcmds=(${SUBCOMMANDS.map((s) => `'${s}'`).join(' ')})`,
          `  if (( CURRENT == 2 )); then`,
          `    _describe 'command' subcmds`,
          `  elif [[ \$words[2] == auth && CURRENT -eq 3 ]]; then`,
          `    local -a auth; auth=('login' 'status' 'logout'); _describe 'auth' auth`,
          `  fi`,
          `}`,
          `_geoly "\$@"`,
        ].join('\n'),
      );
      return 0;
    }
    throw new GeolyError('usage_error', `Unsupported shell "${this.shell}" (bash | zsh)`);
  }
}
