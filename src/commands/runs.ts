/**
 * `geoly runs wait <run_id>` / `geoly runs list` — the follow-up half of `geoly run`.
 *
 * `wait` is what the `next` hint after a `running` hand-off points at: poll the run log until
 * the run finishes (or the wait budget is spent again). `list` finds recent runs when the id
 * got lost (a killed shell, a 524 on the sync path).
 */
import { Command, Option } from 'clipanion';
import { Ctx } from '../context.js';
import { GeolyError, renderExitCodeTable } from '../errors.js';
import { printResult, status } from '../output.js';
import { listRuns, normalizeStatus, waitRun } from '../runs.js';
import { GeolyCommand } from './base.js';
import { DEFAULT_POLL_INTERVAL_S, DEFAULT_WAIT_S, emitOutcome, interruptSignal, resolveWaitMs } from './run.js';

export class RunsWaitCommand extends GeolyCommand {
  static paths = [['runs', 'wait']];
  static usage = Command.Usage({
    category: 'Agent',
    description: 'Wait for a run that is still going on the server and print its receipt when it finishes.',
    details: `
      Polls \`GET /api/agent/runs/<id>\` every \`--interval\` seconds for up to \`--wait\` seconds.
      Still running when the budget is spent → exits 0 with \`status: running\` and the same
      \`next\` command; just run it again.

      Exit codes:
${renderExitCodeTable()}
    `,
    examples: [
      ['Pick up a handed-off run', 'geoly runs wait run_01J…'],
      ['Wait longer, poll less often', 'geoly runs wait run_01J… --wait 300 --interval 10'],
    ],
  });

  runId = Option.String({ required: true, name: 'run_id' });
  wait = Option.String('--wait', { description: `Seconds to wait before handing off again (default ${DEFAULT_WAIT_S})` });
  interval = Option.String('--interval', { description: `Seconds between polls (default ${DEFAULT_POLL_INTERVAL_S})` });
  noSave = Option.Boolean('--no-save', false, { description: 'Do not write the receipt to ./.geoly/runs/' });
  outFile = Option.String('-o,--out', { description: 'Write the receipt to this file; stdout only prints its path' });

  protected async run(ctx: Ctx): Promise<number> {
    const runId = this.runId.trim();
    if (!/^run_[A-Za-z0-9_-]{6,}$/.test(runId)) throw new GeolyError('usage_error', `Not a run id: ${runId}`);
    const intervalS = this.interval === undefined ? DEFAULT_POLL_INTERVAL_S : Number(this.interval);
    if (!Number.isFinite(intervalS) || intervalS < 1) throw new GeolyError('usage_error', '--interval must be at least 1 second');
    const outcome = await waitRun(ctx, runId, {
      waitMs: resolveWaitMs(this.wait, false),
      intervalMs: intervalS * 1000,
      signal: interruptSignal(),
      onPoll: (r) => status(ctx, `· ${runId} · ${normalizeStatus(r.status)}${typeof r.steps === 'number' ? ` · ${r.steps} steps` : ''}`),
    });
    return emitOutcome(ctx, outcome, { save: !this.noSave, outFile: this.outFile, streamed: false });
  }
}

export class RunsListCommand extends GeolyCommand {
  static paths = [['runs', 'list']];
  static usage = Command.Usage({
    category: 'Agent',
    description: 'Recent runs for the organization (receipt fields, newest first).',
    examples: [
      ['Last 20 runs', 'geoly runs list'],
      ['One brand, more rows', 'geoly runs list --brand br_123 --limit 50'],
    ],
  });

  brand = Option.String('--brand', { description: 'Only runs bound to this brand id' });
  limit = Option.String('--limit', { description: 'Rows to return (1–50, default 20)' });

  protected async run(ctx: Ctx): Promise<number> {
    let limit: number | undefined;
    if (this.limit !== undefined) {
      limit = Number(this.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new GeolyError('usage_error', '--limit must be an integer between 1 and 50');
    }
    const result = (await listRuns(ctx, { brandId: this.brand, limit })) as { runs?: Array<Record<string, unknown>> };
    const runs = (result.runs ?? []).map((r) => ({ ...r, status: normalizeStatus(r.status) }));
    printResult(ctx, { runs });
    return 0;
  }
}
