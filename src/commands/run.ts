/**
 * `geoly run "<question>"` — hand one question to GEOly's hosted GEO agent and bring back its
 * receipt. `geoly run <run_id>` looks an earlier run up (and can keep waiting on it).
 *
 * This is the command an agent host (Claude Code, Codex…) runs on the user's behalf: the user
 * signed in once, the credential stays here, the agent only sees the receipt. The loop, tools
 * and billing all live on the server (`/api/agent/runs`); the local chat agent (`geoly`) is a
 * different, local loop — this command never touches it.
 *
 * Output contract: stdout is the receipt (JSON by default, `--output raw` streams the answer),
 * progress goes to stderr (`-q` silences it). `status` in the JSON is the thing to branch on:
 * `done` / `failed` are final; `running` means the server is still working and the printed
 * `next` command picks it up — exit code 0, because nothing failed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Option } from 'clipanion';
import { runsDir } from '../config.js';
import { Ctx } from '../context.js';
import { GeolyError, renderExitCodeTable } from '../errors.js';
import { printResult, status } from '../output.js';
import { RunEvent, RunOutcome, RunRequest, idempotencyKeyFor, normalizeStatus, startRun, waitRun } from '../runs.js';
import { GeolyCommand } from './base.js';

/** Default follow budget: under the 120s an agent host typically allows one shell command. */
export const DEFAULT_WAIT_S = 100;
export const DEFAULT_POLL_INTERVAL_S = 3;
const RUN_ID_RE = /^run_[A-Za-z0-9_-]{6,}$/;

/** Shared by `run`, `runs wait`: render one outcome to stdout/stderr and return the exit code. */
export async function emitOutcome(
  ctx: Ctx,
  outcome: RunOutcome,
  opts: { save: boolean; outFile?: string; streamed: boolean },
): Promise<number> {
  if (outcome.kind === 'running') {
    const next = `geoly runs wait ${outcome.runId}`;
    status(ctx, `· still running on the server after ${outcome.elapsedS}s — ${next}`);
    if (opts.streamed) process.stdout.write('\n');
    printResult(ctx, { status: 'running', run_id: outcome.runId, elapsed_s: outcome.elapsedS, next });
    return 0;
  }
  if (outcome.kind === 'failed') {
    throw new GeolyError('tool_error', outcome.message, {
      hint: outcome.runId ? `Run ${outcome.runId} failed on the server (${outcome.code}). Credits for a failed run are refunded.` : outcome.code,
      next: outcome.runId ? `geoly run ${outcome.runId}` : undefined,
    });
  }
  const record = outcome.kind === 'replayed' ? outcome.record : outcome.payload;
  const runId = typeof record.run_id === 'string' ? record.run_id : undefined;
  const st = outcome.kind === 'replayed' ? normalizeStatus(record.status) : 'done';
  if (outcome.kind === 'replayed') status(ctx, `· replayed run ${runId ?? '?'} (same command within 10 minutes)`);
  if (st === 'running' && runId) {
    return emitOutcome(ctx, { kind: 'running', runId, elapsedS: 0 }, opts);
  }
  // Normalized status wins over the record's raw one (`succeeded` → `done`): one vocabulary everywhere.
  const result: Record<string, unknown> = { ...record, status: st };
  if (opts.save && runId) {
    const saved = saveReceipt(runId, result, opts.outFile);
    if (saved) result.saved_to = saved;
  }
  if (opts.streamed) {
    // The answer already went to stdout as text; finish with a bare run id for reference.
    process.stdout.write(`\n${runId ?? ''}\n`);
    return 0;
  }
  if (opts.outFile) {
    printResult(ctx, { status: st, run_id: runId, saved_to: result.saved_to });
    return 0;
  }
  printResult(ctx, result);
  return 0;
}

/** `./.geoly/runs/<run_id>.json` (or an explicit path). Returns the path written, or undefined. */
function saveReceipt(runId: string, result: Record<string, unknown>, outFile?: string): string | undefined {
  try {
    const target = outFile ? path.resolve(outFile) : path.join(runsDir(), `${runId}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return outFile ? target : path.relative(process.cwd(), target).split(path.sep).join('/');
  } catch {
    return undefined; // the receipt on stdout is the contract; the file is a convenience
  }
}

/** One stderr line per server event — enough to see what the agent is doing, never the answer. */
export function describeEvent(ctx: Ctx, ev: RunEvent): void {
  const d = ev.data;
  switch (ev.event) {
    case 'started': {
      const brand = d.brand && typeof d.brand === 'object' ? (d.brand as { name?: string }).name : undefined;
      status(ctx, `· run ${String(d.run_id ?? '?')}${brand ? ` · ${brand}` : ''}${d.model ? ` · ${String(d.model)}` : ''}`);
      break;
    }
    case 'step':
      status(ctx, `· step ${String(d.index ?? '?')}`);
      break;
    case 'tool':
      status(ctx, `  · ${String(d.name ?? 'tool')}${d.ok === false ? ' ✗' : ''}${typeof d.ms === 'number' ? ` (${Math.round(d.ms / 1000)}s)` : ''}`);
      break;
    case 'tools_loaded':
      status(ctx, `  · loaded ${Array.isArray(d.names) ? d.names.length : '?'} tools for "${String(d.query ?? '')}"`);
      break;
    case 'step_error':
      status(ctx, `  · step error: ${String(d.message ?? '')}`);
      break;
    default:
      break; // heartbeat, text (handled by the caller), unknown
  }
}

/** Ctrl-C aborts the follow, not the run: print the hand-off and leave with exit 0. */
export function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return controller.signal;
}

export class RunCommand extends GeolyCommand {
  static paths = [['run']];
  static usage = Command.Usage({
    category: 'Agent',
    description: 'Ask the hosted GEO agent a question and get a receipt; or look up / keep waiting on a run by id.',
    details: `
      Follows the run for up to \`--wait\` seconds (default ${DEFAULT_WAIT_S}). If it is not done by
      then the command still exits 0 and prints \`{"status":"running","run_id":…,"next":…}\` —
      the run keeps going on the server; run the \`next\` command to pick it up.

      The full receipt is also written to \`./.geoly/runs/<run_id>.json\` (\`--no-save\` to skip).
      Re-running the exact same command within 10 minutes replays the same run instead of
      starting (and paying for) a new one.

      Exit codes:
${renderExitCodeTable()}
    `,
    examples: [
      ['Ask a question', 'geoly run "how did our visibility move this week?" --brand br_123'],
      ['Server-defined deliverable with a spend cap', 'geoly run "weekly health" --spec weekly-brand-health --max-credits 300'],
      ['Stream the answer as text', 'geoly run --output raw "which sources cite us most?"'],
      ['Look up an earlier run', 'geoly run run_01J…'],
      ['Start and return immediately', 'geoly run --no-wait "compare us with EcoFlow on ChatGPT"'],
    ],
  });

  question = Option.String({ required: true, name: 'question | run_id' });
  brand = Option.String('--brand', { description: 'Brand id to bind the run to (defaults to the token brand)' });
  spec = Option.String('--spec', { description: 'Server-defined deliverable spec (e.g. weekly-brand-health, content-brief)' });
  extraContext = Option.String('--context', { description: 'Extra input for the agent; @file reads a file' });
  maxCredits = Option.String('--max-credits', { description: 'Cap this run\'s spend (credits, 25..2000)' });
  wait = Option.String('--wait', { description: `Seconds to follow before handing off (default ${DEFAULT_WAIT_S})` });
  noWait = Option.Boolean('--no-wait', false, { description: 'Return as soon as the server acknowledges the run' });
  noSave = Option.Boolean('--no-save', false, { description: 'Do not write the receipt to ./.geoly/runs/' });
  outFile = Option.String('-o,--out', { description: 'Write the receipt to this file; stdout only prints its path' });
  idempotencyKey = Option.String('--idempotency-key', { description: 'Override the key used to de-duplicate retries' });

  protected async run(ctx: Ctx): Promise<number> {
    const waitMs = resolveWaitMs(this.wait, this.noWait);
    const signal = interruptSignal();
    const outputOpts = { save: !this.noSave, outFile: this.outFile, streamed: ctx.output === 'raw' };

    // Status / keep-waiting mode: the positional is a run id.
    if (RUN_ID_RE.test(this.question.trim())) {
      const runId = this.question.trim();
      const outcome = await waitRun(ctx, runId, {
        waitMs: this.wait === undefined && !this.noWait ? 0 : waitMs,
        intervalMs: DEFAULT_POLL_INTERVAL_S * 1000,
        signal,
        onPoll: (r) => status(ctx, `· ${runId} · ${normalizeStatus(r.status)}${typeof r.steps === 'number' ? ` · ${r.steps} steps` : ''}`),
      });
      return emitOutcome(ctx, outcome, { ...outputOpts, streamed: false });
    }

    const req: RunRequest = { question: this.question.trim(), brandId: this.brand, spec: this.spec };
    if (!req.question) throw new GeolyError('usage_error', 'Question is empty');
    if (this.extraContext !== undefined) req.context = readContext(this.extraContext);
    if (this.maxCredits !== undefined) {
      const n = Number(this.maxCredits);
      if (!Number.isInteger(n) || n < 25 || n > 2000) throw new GeolyError('usage_error', '--max-credits must be an integer between 25 and 2000');
      req.maxCredits = n;
    }
    if (this.idempotencyKey !== undefined && !/^[A-Za-z0-9_\-:.]{8,128}$/.test(this.idempotencyKey)) {
      throw new GeolyError('usage_error', '--idempotency-key must be 8–128 characters of [A-Za-z0-9_-:.]');
    }

    const streamed = ctx.output === 'raw';
    const outcome = await startRun(ctx, req, {
      waitMs,
      idempotencyKey: this.idempotencyKey ?? idempotencyKeyFor(ctx, req),
      signal,
      onEvent: (ev) => {
        if (ev.event === 'text') {
          if (streamed && typeof ev.data.delta === 'string') process.stdout.write(ev.data.delta);
          return;
        }
        describeEvent(ctx, ev);
      },
    });
    return emitOutcome(ctx, outcome, outputOpts);
  }
}

/** `--wait` in seconds → ms; `--no-wait` = 0. Anything non-numeric or negative is a usage error. */
export function resolveWaitMs(wait: string | undefined, noWait: boolean): number {
  if (noWait) return 0;
  if (wait === undefined) return DEFAULT_WAIT_S * 1000;
  const n = Number(wait);
  if (!Number.isFinite(n) || n < 0) throw new GeolyError('usage_error', '--wait must be a non-negative number of seconds');
  return Math.round(n * 1000);
}

/** `--context "text"` or `--context @path` (file contents). */
function readContext(value: string): string {
  if (!value.startsWith('@')) return value;
  const file = value.slice(1);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new GeolyError('usage_error', `Could not read --context file: ${file}`, { cause: err });
  }
}
