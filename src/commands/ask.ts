/**
 * `geoly ask "<question>"` — one turn with the hosted GEO agent.
 *
 * Unlike `geoly call`, which executes a single named tool, `ask` hands the
 * question to the server-side agent: it picks the tools, runs as many steps as
 * it needs, and answers. The tool surface is the same one `geoly tools` lists.
 *
 * Output contract (CONTRACT.md) is preserved: stdout is the data channel
 * (`--output json` envelope by default, `--output raw` streams the answer text
 * live), while tool activity and the usage summary go to stderr and are
 * silenced by `-q`.
 */
import { Command, Option } from 'clipanion';
import { AgentEvent, runAgentTurn } from '../agent.js';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { printResult, status } from '../output.js';
import { GeolyCommand } from './base.js';

export class AskCommand extends GeolyCommand {
  static paths = [['ask']];
  static usage = Command.Usage({
    description: 'Ask the hosted GEO agent a question; it picks and runs the tools itself.',
    examples: [
      ['Plain question', 'geoly ask "how did our visibility move over the last 30 days?"'],
      ['Stream the answer as text', 'geoly ask --output raw "which sources cite us most?"'],
      ['Pin a brand', 'geoly ask --brand br_123 "top competitors on ChatGPT"'],
    ],
  });

  question = Option.String({ required: true });
  brand = Option.String('--brand', { description: 'Brand id to bind this run to (defaults to the token brand)' });
  locale = Option.String('--locale', { description: 'Answer language: zh | en' });

  protected async run(ctx: Ctx): Promise<number> {
    const question = this.question.trim();
    if (!question) throw new GeolyError('usage_error', 'Question is empty');
    if (this.locale && this.locale !== 'zh' && this.locale !== 'en') {
      throw new GeolyError('usage_error', `--locale must be zh or en, got: ${this.locale}`);
    }

    const streaming = ctx.output === 'raw';
    const chunks: string[] = [];
    const toolsUsed: string[] = [];
    let meta: Extract<AgentEvent, { type: 'ready' }> | undefined;
    let done: Extract<AgentEvent, { type: 'done' }> | undefined;
    let failure: string | undefined;

    for await (const event of runAgentTurn(ctx, {
      messages: [{ role: 'user', content: question }],
      brandId: this.brand,
      locale: this.locale as 'zh' | 'en' | undefined,
    })) {
      switch (event.type) {
        case 'ready':
          meta = event;
          status(ctx, `· ${event.brand.name} · ${event.model}`);
          break;
        case 'text':
          if (streaming) process.stdout.write(event.text);
          else chunks.push(event.text);
          break;
        case 'tool':
          if (event.phase === 'call') {
            toolsUsed.push(event.name);
            status(ctx, `· ${event.name}`);
          } else if (event.phase === 'error') {
            status(ctx, `· ${event.name} failed: ${event.message ?? 'unknown error'}`);
          }
          break;
        case 'done':
          done = event;
          break;
        case 'error':
          failure = event.message;
          break;
      }
    }

    if (failure) throw new GeolyError('tool_error', `Agent run failed: ${failure}`);

    if (streaming) {
      // Live mode already wrote the answer; close the line and summarize on stderr.
      if (chunks.length === 0) process.stdout.write('\n');
    } else {
      printResult(ctx, {
        brand: meta?.brand ?? null,
        model: meta?.model ?? null,
        text: chunks.join(''),
        tools: toolsUsed,
        usage: done?.usage ?? null,
        finishReason: done?.finish_reason ?? null,
      });
    }
    if (done) {
      status(
        ctx,
        `· ${done.usage.total} tokens · ${Math.round(done.duration_ms / 1000)}s · ${done.finish_reason}`,
      );
    }
    return 0;
  }
}
