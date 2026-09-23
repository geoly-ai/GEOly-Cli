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
import { printResult, status, warn } from '../output.js';
import { RunEvent, RunOutcome, RunRequest, idempotencyKeyFor, normalizeStatus, startRun, waitRun } from '../runs.js';
import { GeolyCommand } from './base.js';

/** Default follow budget: under the 120s an agent host typically allows one shell command. */
export const DEFAULT_WAIT_S = 100;
export const DEFAULT_POLL_INTERVAL_S = 3;
const RUN_ID_RE = /^run_[A-Za-z0-9_-]{6,}$/;

/**
 * Shared by `run`, `runs wait`: render one outcome to stdout/stderr and return the exit code.
 * `opts.streamed` = the answer text was already streamed to stdout (raw mode following SSE);
 * for a replay / poll result in raw mode the answer has not been shown yet and is printed here.
 */
export async function emitOutcome(
  ctx: Ctx,
  outcome: RunOutcome,
  opts: {
    save: boolean;
    outFile?: string;
    streamed: boolean;
    /** What the CLI itself knows about the request — the live `done` event does not echo it. */
    known?: { question?: string; max_credits?: number };
  },
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
  // A replayed failure is still a failure: same exit code as the live `error` event (review #4),
  // so a script that branches on $? sees the same thing whether the run failed now or 5 minutes ago.
  if (st === 'failed') {
    return emitOutcome(
      ctx,
      { kind: 'failed', runId, code: 'RUN_FAILED', message: String(record.error ?? 'run failed') },
      opts,
    );
  }
  // Normalized status wins over the record's raw one (`succeeded` → `done`): one vocabulary everywhere.
  // The live `done` event carries no question / max_credits (the server assumes you know what
  // you asked); a lookup does. Fill them from the request so a script parsing receipts sees one
  // key set whether the run finished now or is read back later.
  const result: Record<string, unknown> = { ...record, status: st };
  if (opts.known?.question !== undefined && result.question === undefined) result.question = opts.known.question;
  if (opts.known?.max_credits !== undefined && result.max_credits === undefined) result.max_credits = opts.known.max_credits;
  // `stopped: max_steps` means the agent did not finish on its own terms — a budget cap
  // (`stopped_reason: budget`) usually leaves a placeholder answer. `status` stays `done` and the
  // exit code 0 (nothing failed, credits were spent), but say so where an agent will read it.
  if (result.stopped === 'max_steps') {
    const reason = typeof result.stopped_reason === 'string' ? result.stopped_reason : 'max_steps';
    warn(
      reason === 'budget'
        ? `geoly: run ${runId ?? ''} stopped at its credit cap (${String(result.credits_cost ?? '?')} credits) — the answer is partial; raise --max-credits to finish it`
        : `geoly: run ${runId ?? ''} stopped early (${reason}) — treat the answer as partial (see \`stopped\` in the receipt)`,
    );
  }
  // `-o` always means "write it there" — it wins over --no-save (review #6).
  const wantSave = opts.save || !!opts.outFile;
  let saved: string | undefined;
  if (wantSave && runId) {
    const attempt = saveReceipt(runId, result, opts.outFile);
    if (attempt.path) {
      saved = attempt.path;
      result.saved_to = saved;
    } else if (opts.outFile) {
      warn(`geoly: could not write ${opts.outFile} (${attempt.reason}) — printing the receipt to stdout instead`);
    } else {
      // The default location is the cwd; a read-only one used to drop the file with no trace.
      warn(`geoly: receipt not saved to ./.geoly/runs/ (${attempt.reason}); pass -o <file> or --no-save`);
    }
  }
  if (opts.streamed) {
    // The answer already went to stdout as text; the run id goes to stderr so `> answer.md`
    // holds only the answer (it used to end with a bare run id line).
    process.stdout.write('\n');
    status(ctx, `· run ${runId ?? '?'} · ${st}`);
    return 0;
  }
  if (ctx.output === 'raw') {
    // Raw mode without a live stream (replay / poll / lookup): the answer was never shown — show it (review #5).
    const answer = typeof record.answer === 'string' ? record.answer : '';
    process.stdout.write(`${answer}${answer.endsWith('\n') || !answer ? '' : '\n'}`);
    status(ctx, `· run ${runId ?? '?'} · ${st}`);
    return 0;
  }
  if (opts.outFile && saved) {
    printResult(ctx, { status: st, run_id: runId, saved_to: saved });
    return 0;
  }
  printResult(ctx, result);
  return 0;
}

/** `./.geoly/runs/<run_id>.json` (or an explicit path). The receipt on stdout is the contract; the file is a convenience. */
function saveReceipt(runId: string, result: Record<string, unknown>, outFile?: string): { path?: string; reason?: string } {
  try {
    const target = outFile ? path.resolve(outFile) : path.join(runsDir(), `${runId}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return { path: outFile ? target : path.relative(process.cwd(), target).split(path.sep).join('/') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { reason: code ?? (err instanceof Error ? err.message : String(err)) };
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
      ['Server-defined deliverable with a spend cap', 'geoly run "weekly health" --spec geo-weekly-brand-health --max-credits 300'],
      ['Stream the answer as text', 'geoly run --output raw "which sources cite us most?"'],
      ['Look up an earlier run', 'geoly run run_01J…'],
      ['Start and return immediately', 'geoly run --no-wait "compare us with EcoFlow on ChatGPT"'],
    ],
  });

  question = Option.String({ required: true, name: 'question | run_id' });
  brand = Option.String('--brand', { description: 'Brand id to bind the run to (defaults to the token brand)' });
  spec = Option.String('--spec', { description: 'Server-defined deliverable spec (e.g. geo-weekly-brand-health, geo-content-brief, geo-serp-gap, geo-keyword-research-report)' });
  extraContext = Option.String('--context', { description: 'Extra input for the agent; @file reads a file' });
  maxCredits = Option.String('--max-credits', { description: 'Cap this run\'s spend (credits, 25..2000)' });
  allowWrites = Option.Boolean('--allow-writes', false, {
    description: 'Let the agent call GEOly write tools (archive_prompt, update_prompt_tags, move_prompts_to_topic, create_*); needs a Write grant on the token',
  });
  wait = Option.String('--wait', { description: `Seconds to follow before handing off (default ${DEFAULT_WAIT_S})` });
  noWait = Option.Boolean('--no-wait', false, { description: 'Return as soon as the server acknowledges the run' });
  noSave = Option.Boolean('--no-save', false, { description: 'Do not write the receipt to ./.geoly/runs/' });
  outFile = Option.String('-o,--out', { description: 'Write the receipt to this file; stdout then prints only {status, run_id, saved_to}' });
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
    if (this.allowWrites) req.allowWrites = true;
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
    const known = { question: req.question, max_credits: req.maxCredits };
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
    return emitOutcome(ctx, outcome, { ...outputOpts, known });
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
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new GeolyError('usage_error', `Could not read --context file: ${file}`, { cause: err });
  }
  return decodeTextFile(bytes, file);
}

/**
 * Text files reach us in whatever encoding the user's shell wrote them: Windows PowerShell 5.1
 * `Out-File` is UTF-16LE with a BOM, `Out-File -Encoding utf8` keeps a UTF-8 BOM, `Set-Content`
 * follows the system code page (GBK on a Chinese machine). Reading all of that as UTF-8 handed
 * the agent `R\uFFFD\uFFFD\uFFFD-7731` and charged for it. Honour the BOMs; refuse bytes that are not
 * valid UTF-8 rather than guess a code page.
 */
export function decodeTextFile(bytes: Buffer, file: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new GeolyError('usage_error', `--context file is not UTF-8 text: ${file}`, {
      hint: 'Save it as UTF-8 (PowerShell: `Set-Content -Encoding utf8`; the default Out-File on Windows PowerShell 5.1 writes UTF-16).',
    });
  }
}
