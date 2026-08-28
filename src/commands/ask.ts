/**
 * `geoly ask "<question>"` — one question, answered by the local agent worker.
 *
 * Unlike `geoly call`, which runs one named tool, `ask` hands the question to
 * the agent loop running in this process: it picks tools, runs them, and keeps
 * going until it can answer. Inference is hosted and metered; the loop, the
 * memory, and the transcript are local.
 *
 * Output contract (CONTRACT.md) is preserved: stdout is the data channel
 * (`--output json` envelope by default, `--output raw` streams the answer live),
 * while step/tool progress and the usage summary go to stderr and `-q` silences them.
 */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError } from '../errors.js';
import { LoopEvent, runLoop } from '../loop.js';
import { printResult, status } from '../output.js';
import { GeolyCommand } from './base.js';

export class AskCommand extends GeolyCommand {
  static paths = [['ask']];
  static usage = Command.Usage({
    description: 'Ask the GEO agent a question; it picks and runs the tools itself.',
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
    let ready: Extract<LoopEvent, { type: 'ready' }> | undefined;
    let done: Extract<LoopEvent, { type: 'done' }> | undefined;

    for await (const event of runLoop(ctx, {
      question,
      brandId: this.brand,
      locale: this.locale as 'zh' | 'en' | undefined,
    })) {
      switch (event.type) {
        case 'ready':
          ready = event;
          status(
            ctx,
            `· ${event.profile.brand.name} · ${event.profile.model} · ${event.toolCount} tools` +
              (event.memoryNotes > 0 ? ` · ${event.memoryNotes} memory notes` : ''),
          );
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
        case 'step':
          break;
      }
    }

    if (streaming) {
      process.stdout.write('\n');
    } else {
      printResult(ctx, {
        brand: ready?.profile.brand ?? null,
        model: ready?.profile.model ?? null,
        text: chunks.join(''),
        tools: toolsUsed,
        steps: done?.steps ?? null,
        usage: done ? { total: done.totalTokens } : null,
      });
    }
    if (done) {
      const budget = done.stopped === 'budget' ? ' · step budget reached' : '';
      status(ctx, `· ${done.steps} steps · ${done.totalTokens} tokens${budget}`);
    }
    return 0;
  }
}
