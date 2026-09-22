/**
 * Offline verification of the `geoly run` client and the error mappings that PR-B added
 * (`node --import tsx scripts/verify-run.mts`). A local fake of the Agent API + MCP endpoint
 * plays the server so the parts that cannot be exercised against production before the
 * server change ships (idempotent replay, in-band rate limit, -32602) still get a run.
 *
 * Covers:
 *  1. follow to `done` — receipt comes back, Idempotency-Key was sent;
 *  2. wait budget spent → `running` hand-off with the run id (fetch aborted, no throw);
 *  3. `--no-wait` → returns right after `started`;
 *  4. idempotent replay → server answers JSON, client reports `replayed`;
 *  5. `error` event → `failed`;
 *  6. waitRun polls GET until `succeeded` → `done`;
 *  7. MCP -32602 → usage_error (exit 2), not tool_error;
 *  8. in-band GUARDED_RATE_LIMITED → one retry after retry_after_seconds, then the real result;
 *  9. TOOL_TIMEOUT tail → upstream_unavailable with retryAfter (via unwrapToolResult);
 * 10. paste-code completion → `--code` exchanges with the parked verifier and stores tokens;
 * 11. README's exit-code block equals errors.ts EXIT_CODE_TABLE (docs drift gate);
 * 12. `--no-wait` when the server sends headers first and `started` on a later packet (the real
 *     shape through a proxy) still returns `running` with the run id — no 0ms-timer race;
 * 13. after `done`, no timers/sockets keep the process alive (the follow-up work must be able to
 *     exit immediately; a lingering 35s idle timer used to hold it);
 * 14. a replayed `failed` record exits 1 like a live failure; raw-mode replay prints the answer
 *     (and only the answer — the run id goes to stderr, 0.3.1);
 * 15. a server that never sends headers → upstream_unavailable inside `--timeout` (0.3.1: the
 *     deadline used to be missing on the streaming request entirely);
 * 16. `geoly call` rejects parameters the schema does not declare — typo, and brand/org
 *     scoping on a single-brand token — as usage_error, before anything is sent;
 * 17. `--context @file` decodes UTF-8 (BOM or not) and UTF-16 (BOM) and refuses other bytes;
 * 18. a bad command line (missing positional / unknown flag / unknown subcommand) is a
 *     usage_error on stderr with exit 2 and honours --error-format json — never stdout / exit 1;
 * 19. a run stopped by its credit cap keeps status done / exit 0 but says so on stderr, and the
 *     fresh receipt carries the question and max_credits the CLI knows;
 * 20. a write tool is never sent without `writeApproved` (write_blocked, exit 1, nothing on the
 *     wire) and goes through with it — the seven server write tools are all gated;
 * 21. an SSE reply whose stream stays open after the JSON-RPC frame (proxy / keep-alive) is
 *     resolved from the frame at once instead of waiting for EOF (0.3.1: twice in production a
 *     19s tool answer was thrown away because the CLI sat on `res.text()` until its own timeout).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ctx } from '../src/context.js';
import { EXIT_CODE_TABLE, GeolyError } from '../src/errors.js';
import { McpClient, unwrapToolResult } from '../src/mcp.js';
import { startRun, waitRun } from '../src/runs.js';
import { spawnSync } from 'node:child_process';
import { decodeTextFile, emitOutcome } from '../src/commands/run.js';
import { assertKnownParam } from '../src/commands/call.js';
import { completeRemoteLogin } from '../src/oauth.js';
import { pendingAuthPath, writeJson, credentialsPath, readJson } from '../src/config.js';

type Mode = 'done' | 'slow' | 'replay' | 'fail' | 'lateStart' | 'replayFailed' | 'hang' | 'budget';
let mode: Mode = 'done';
let seenIdempotencyKey: string | undefined;
let pollCount = 0;
let rpcCalls = 0;
let guardedServed = false;
let writeCalls = 0;
let tokenExchanges: Array<Record<string, string>> = [];

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // ---- Agent API ----
    if (req.method === 'POST' && url.pathname === '/api/agent/runs') {
      seenIdempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (mode === 'replay') {
        res.writeHead(200, { 'content-type': 'application/json', 'idempotent-replayed': 'true' });
        res.end(JSON.stringify({ run_id: 'run_replay1', status: 'succeeded', answer: 'earlier answer', replayed: true }));
        return;
      }
      if (mode === 'replayFailed') {
        res.writeHead(200, { 'content-type': 'application/json', 'idempotent-replayed': 'true' });
        res.end(JSON.stringify({ run_id: 'run_replay2', status: 'failed', answer: null, error: 'MODEL_ERROR', replayed: true }));
        return;
      }
      if (mode === 'hang') {
        // never answers — not even headers; the socket is released when the client aborts
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'budget') {
        res.write(sse('started', { run_id: 'run_budget1', brand: { id: 'b', name: 'Brand' }, model: 'm' }));
        res.write(sse('done', { run_id: 'run_budget1', answer: 'could not complete', stopped: 'max_steps', stopped_reason: 'budget', credits_cost: 25, credits_remaining: 'unlimited', steps: 3 }));
        res.end();
        return;
      }
      if (mode === 'lateStart') {
        res.flushHeaders(); // headers on the wire NOW; without this Node holds them until the first write
        // headers now, `started` 120ms later on its own packet — what a CDN hop looks like
        setTimeout(() => {
          res.write(sse('started', { run_id: 'run_late001', brand: { id: 'b', name: 'Brand' }, model: 'm' }));
          const t = setInterval(() => res.write(sse('heartbeat', {})), 200);
          res.on('close', () => clearInterval(t)); // res, not req: IncomingMessage 'close' fires once the body is consumed, before the socket goes
        }, 120);
        return;
      }
      res.write(sse('started', { run_id: 'run_test001', brand: { id: 'b', name: 'Brand' }, model: 'm' }));
      res.write(sse('step', { index: 1 }));
      if (mode === 'fail') {
        res.write(sse('error', { code: 'RUN_FAILED', message: 'boom' }));
        res.end();
        return;
      }
      if (mode === 'slow') {
        // keep the stream open with heartbeats; the client must give up on its own budget
        const t = setInterval(() => res.write(sse('heartbeat', {})), 200);
        res.on('close', () => clearInterval(t)); // res, not req: IncomingMessage 'close' fires once the body is consumed, before the socket goes
        return;
      }
      res.write(sse('text', { delta: 'hello' }));
      res.write(sse('done', { run_id: 'run_test001', answer: 'hello', credits_cost: 3, credits_remaining: 97, steps: 1 }));
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/runs/run_test001') {
      pollCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: 'run_test001', status: pollCount >= 2 ? 'succeeded' : 'running', answer: pollCount >= 2 ? 'late answer' : null, steps: pollCount }));
      return;
    }
    // ---- token endpoint (paste-code completion) ----
    if (req.method === 'POST' && url.pathname === '/api/auth/mcp/token') {
      tokenExchanges.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok_remote', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' }));
      return;
    }
    // ---- MCP endpoint ----
    if (req.method === 'POST' && url.pathname === '/api/mcp') {
      rpcCalls += 1;
      const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } };
      if (rpc.method !== 'tools/call' || rpc.params?.name !== 'sse_open') {
        res.writeHead(200, { 'content-type': 'application/json' });
      }
      if (rpc.method === 'tools/call' && rpc.params?.name === 'bad_params') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Invalid arguments: time_range' } }));
        return;
      }
      if (rpc.method === 'tools/call' && rpc.params?.name === 'archive_prompt') {
        writeCalls += 1;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"success":true,"changed":true}' }] } }));
        return;
      }
      if (rpc.method === 'tools/call' && rpc.params?.name === 'sse_open') {
        // Frame first, then heartbeats forever: the client must not need EOF to read the answer.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`: ping\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"late":false}' }] } })}\n\n`);
        const t = setInterval(() => res.write(': ping\n\n'), 100);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (rpc.method === 'tools/call' && rpc.params?.name === 'guarded') {
        if (!guardedServed) {
          guardedServed = true;
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'RATE_LIMITED: guarded is capped.\n{"error":"GUARDED_RATE_LIMITED","tool":"guarded","limit_per_minute":5,"retry_after_seconds":1}' }] } }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (process.env.VERIFY_TRACE_TIMERS) {
    const t = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    console.log(`      [timers=${t}]`);
  }
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/api/mcp`;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-verify-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const ctx: Ctx = {
    endpoint,
    profile: 'verify',
    output: 'json',
    errorFormat: 'json',
    quiet: true,
    timeoutMs: 5_000,
    noAutoAuth: true,
    noBrowser: true,
    remote: false,
    staticToken: 'geom_test',
  };
  const req = { question: 'q', brandId: 'b' };

  // 1. done
  mode = 'done';
  const done = await startRun(ctx, req, { waitMs: 5_000, idempotencyKey: 'a'.repeat(16) });
  check('1 follow to done', done.kind === 'done' && (done as { payload: { answer?: string } }).payload.answer === 'hello');
  check('1 idempotency key sent', seenIdempotencyKey === 'a'.repeat(16), String(seenIdempotencyKey));

  // 2. budget → running
  mode = 'slow';
  const t0 = Date.now();
  const slow = await startRun(ctx, req, { waitMs: 600 });
  check('2 budget → running hand-off', slow.kind === 'running' && slow.runId === 'run_test001', JSON.stringify(slow));
  check('2 gave up near the budget', Date.now() - t0 < 3_000, `${Date.now() - t0}ms`);

  // 3. no-wait
  const nowait = await startRun(ctx, req, { waitMs: 0 });
  check('3 --no-wait returns after started', nowait.kind === 'running' && nowait.runId === 'run_test001');

  // 4. replay
  mode = 'replay';
  const replay = await startRun(ctx, req, { waitMs: 5_000, idempotencyKey: 'b'.repeat(16) });
  check('4 replay recognised', replay.kind === 'replayed' && (replay as { record: { run_id?: string } }).record.run_id === 'run_replay1');

  // 5. error event
  mode = 'fail';
  const failed = await startRun(ctx, req, { waitMs: 5_000 });
  check('5 error event → failed', failed.kind === 'failed' && (failed as { message: string }).message === 'boom');

  // 6. waitRun polls to done
  pollCount = 0;
  const waited = await waitRun(ctx, 'run_test001', { waitMs: 10_000, intervalMs: 50 });
  check('6 waitRun polls until succeeded', waited.kind === 'done' && pollCount === 2, `polls=${pollCount}`);

  // 7. -32602
  const client = new McpClient(ctx);
  try {
    await client.callTool('bad_params', {});
    check('7 -32602 → usage_error', false, 'did not throw');
  } catch (err) {
    check('7 -32602 → usage_error', err instanceof GeolyError && err.kind === 'usage_error' && err.exitCode === 2, err instanceof GeolyError ? err.kind : String(err));
  }

  // 8. in-band rate limit retried once
  const before = rpcCalls;
  const guarded = await client.callTool('guarded', {});
  check('8 GUARDED_RATE_LIMITED retried once then succeeded', !guarded.isError && rpcCalls - before === 2, `calls=${rpcCalls - before}`);

  // 9. TOOL_TIMEOUT tail mapping
  try {
    unwrapToolResult('slow_tool', { isError: true, content: [{ type: 'text', text: 'TOOL_TIMEOUT: slow_tool timed out.\n{"error":"TOOL_TIMEOUT","tool":"slow_tool","retry_after_seconds":60}' }] });
    check('9 TOOL_TIMEOUT → upstream_unavailable', false, 'did not throw');
  } catch (err) {
    check('9 TOOL_TIMEOUT → upstream_unavailable + retryAfter', err instanceof GeolyError && err.kind === 'upstream_unavailable' && err.retryAfter === 60);
  }

  // 10. paste-code completion
  const origin = `http://127.0.0.1:${port}`;
  writeJson(credentialsPath('verify'), { origin, client: { clientId: 'cli_1', redirectUris: [`${origin}/api/mcp/cli/code`] } });
  writeJson(pendingAuthPath('verify'), {
    origin,
    clientId: 'cli_1',
    redirectUri: `${origin}/api/mcp/cli/code`,
    state: 's',
    verifier: 'v'.repeat(43),
    tokenEndpoint: `${origin}/api/auth/mcp/token`,
    authorizeUrl: `${origin}/authorize`,
    expiresAt: Date.now() + 60_000,
  });
  const tokens = await completeRemoteLogin({ ...ctx, staticToken: undefined }, 'CODE123');
  const stored = readJson<{ tokens?: { accessToken?: string } }>(credentialsPath('verify'));
  check('10 --code exchanged with parked verifier', tokenExchanges[0]?.code === 'CODE123' && tokenExchanges[0]?.code_verifier === 'v'.repeat(43) && tokenExchanges[0]?.redirect_uri === `${origin}/api/mcp/cli/code`);
  check('10 tokens stored, pending cleared', tokens.accessToken === 'tok_remote' && stored?.tokens?.accessToken === 'tok_remote' && !fs.existsSync(pendingAuthPath('verify')));

  // 12. --no-wait must survive `started` arriving after the headers
  mode = 'lateStart';
  const late = await startRun(ctx, req, { waitMs: 0 });
  check('12 --no-wait returns running when started arrives on a later packet', late.kind === 'running' && late.runId === 'run_late001', JSON.stringify(late));

  // 13. nothing left ticking after a normal completion
  mode = 'done';
  await startRun(ctx, req, { waitMs: 5_000 });
  // timers live outside _getActiveHandles; getActiveResourcesInfo lists them as 'Timeout'.
  // Let the mock server's own `close` handlers (heartbeat intervals from the slow/lateStart modes)
  // run first — only client-side leftovers are the subject here.
  await new Promise((r) => setTimeout(r, 300));
  const resources = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo();
  const timers = resources.filter((r) => r === 'Timeout').length;
  check('13 no lingering client timers after done', timers === 0, `active resources: ${resources.join(',')}`);

  // 14a. replayed failure exits 1 (emitOutcome throws tool_error)
  mode = 'replayFailed';
  const failedReplay = await startRun(ctx, req, { waitMs: 5_000, idempotencyKey: 'c'.repeat(16) });
  let exitKind = 'none';
  try {
    await emitOutcome(ctx, failedReplay, { save: false, streamed: false });
  } catch (err) {
    exitKind = err instanceof GeolyError ? `${err.kind}:${err.exitCode}` : String(err);
  }
  check('14a replayed failed → tool_error exit 1', exitKind === 'tool_error:1', exitKind);

  // 14b. raw mode + replay prints the answer (stdout capture)
  mode = 'replay';
  const raw = await startRun(ctx, req, { waitMs: 5_000, idempotencyKey: 'd'.repeat(16) });
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out.push(String(s));
    return true;
  };
  try {
    await emitOutcome({ ...ctx, output: 'raw' }, raw, { save: false, streamed: false });
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
  check('14b raw replay prints the answer only (run id on stderr)', out.join('') === 'earlier answer\n', JSON.stringify(out.join('')));

  // 15. no headers within --timeout → exit 6 inside the deadline, not when the peer gives up
  mode = 'hang';
  const tHang = Date.now();
  let hangKind = 'none';
  try {
    await startRun({ ...ctx, timeoutMs: 400 }, req, { waitMs: 5_000 });
  } catch (err) {
    hangKind = err instanceof GeolyError ? `${err.kind}:${err.exitCode}` : String(err);
  }
  const hangMs = Date.now() - tHang;
  check('15 hung server → upstream_unavailable exit 6 within --timeout', hangKind === 'upstream_unavailable:6' && hangMs < 2_000, `${hangKind} after ${hangMs}ms`);

  // 16. undeclared call parameters are usage errors
  const schemaTool = { name: 'get_brand_overview', inputSchema: { type: 'object', properties: { time_range: { type: 'string' }, platform: { type: 'string' } } } };
  const paramErr = (name: string): GeolyError | undefined => {
    try {
      assertKnownParam(schemaTool, name, schemaTool.inputSchema.properties as Record<string, Record<string, unknown>>, '--');
      return undefined;
    } catch (err) {
      return err instanceof GeolyError ? err : undefined;
    }
  };
  const typo = paramErr('time-range');
  check('16a typo → usage_error naming the declared parameter', typo?.kind === 'usage_error' && /--time_range/.test(typo.hint ?? ''), typo?.hint);
  const brandErr = paramErr('brand_id');
  check('16b brand_id on a single-brand token → usage_error that explains the token', brandErr?.kind === 'usage_error' && /bound to one brand/.test(brandErr.message), brandErr?.message);
  check('16c declared parameter passes', paramErr('platform') === undefined);
  const anyTool = { name: 'free_form', inputSchema: { type: 'object', properties: {} } };
  let openOk = true;
  try {
    assertKnownParam(anyTool, 'whatever', {}, '--');
  } catch {
    openOk = false;
  }
  check('16d schema without properties accepts anything', openOk);

  // 17. --context file decoding
  const ctxText = 'order_ref: 青龙-7731';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ctxText, 'utf16le')]);
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ctxText, 'utf8')]);
  check('17a UTF-16LE BOM decoded', decodeTextFile(utf16, 'a') === ctxText);
  check('17b UTF-8 BOM stripped', decodeTextFile(utf8bom, 'b') === ctxText);
  check('17c plain UTF-8 untouched', decodeTextFile(Buffer.from(ctxText, 'utf8'), 'c') === ctxText);
  let gbkKind = 'none';
  try {
    decodeTextFile(Buffer.from([0xcb, 0xb5, 0xc3, 0xf7, 0x2d, 0x37]), 'gbk.txt');
  } catch (err) {
    gbkKind = err instanceof GeolyError ? err.kind : String(err);
  }
  check('17d non-UTF-8 bytes refused as usage_error', gbkKind === 'usage_error', gbkKind);

  // 20. write tools are gated client-side until the caller approves
  const wireBefore = rpcCalls;
  let blocked: GeolyError | undefined;
  try {
    await client.callTool('archive_prompt', { prompt_id: 'p1' });
  } catch (err) {
    blocked = err instanceof GeolyError ? err : undefined;
  }
  check('20a write tool without approval → write_blocked exit 1, nothing sent', blocked?.kind === 'write_blocked' && blocked.exitCode === 1 && rpcCalls === wireBefore && writeCalls === 0, `${blocked?.kind} calls=${rpcCalls - wireBefore}`);
  const approved = await client.callTool('archive_prompt', { prompt_id: 'p1' }, { writeApproved: true });
  check('20b write tool with approval goes through', !approved.isError && writeCalls === 1);
  const { WRITE_TOOLS } = await import('../src/mcp.js');
  const expectedWrites = ['archive_prompt', 'create_competitor', 'create_prompt', 'create_topic', 'move_prompts_to_topic', 'trigger_prompt', 'update_prompt_tags'];
  check('20c the seven server write tools are all gated', JSON.stringify([...WRITE_TOOLS].sort()) === JSON.stringify(expectedWrites), [...WRITE_TOOLS].sort().join(','));

  // 21. SSE reply resolved from the frame, not from EOF
  const tSse = Date.now();
  const sseResult = await client.callTool('sse_open', {});
  const sseMs = Date.now() - tSse;
  check('21 open SSE stream → answer taken from the frame within the budget', !sseResult.isError && sseMs < 2_000, `${sseMs}ms`);

  // 18. command-line parse errors: stderr, exit 2, json when asked
  const bin = path.join(process.cwd(), 'src', 'bin.ts');
  const runBin = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', bin, ...args], { encoding: 'utf8', env: { ...process.env, GEOLY_NO_AUTO_AUTH: '1' } });
  const noArg = runBin(['run']);
  check('18a missing positional → exit 2, stdout empty, usage_error on stderr', noArg.status === 2 && noArg.stdout === '' && /usage_error/.test(noArg.stderr), `status=${noArg.status} stdout=${JSON.stringify(noArg.stdout)} stderr=${noArg.stderr.trim()}`);
  const badFlag = runBin(['runs', 'list', '--json', '--error-format', 'json']);
  let badFlagJson: { kind?: string } | undefined;
  try {
    badFlagJson = JSON.parse(badFlag.stderr.trim()) as { kind?: string };
  } catch {
    badFlagJson = undefined;
  }
  check('18b unknown flag + --error-format json → JSON usage_error on stderr, exit 2', badFlag.status === 2 && badFlagJson?.kind === 'usage_error', `status=${badFlag.status} stderr=${badFlag.stderr.trim()}`);

  // 19. budget stop: done / exit 0, stderr says partial, receipt carries what the CLI knows
  mode = 'budget';
  const budgetRun = await startRun(ctx, req, { waitMs: 5_000, idempotencyKey: 'e'.repeat(16) });
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stdoutParts.push(String(s));
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderrParts.push(String(s));
    return true;
  };
  let budgetCode = -1;
  try {
    budgetCode = await emitOutcome(ctx, budgetRun, { save: false, streamed: false, known: { question: 'q?', max_credits: 25 } });
  } finally {
    (process.stdout as unknown as { write: typeof ow }).write = ow;
    (process.stderr as unknown as { write: typeof ew }).write = ew;
  }
  const budgetReceipt = JSON.parse(stdoutParts.join('')) as Record<string, unknown>;
  check('19a budget stop stays done / exit 0', budgetCode === 0 && budgetReceipt.status === 'done' && budgetReceipt.stopped_reason === 'budget');
  check('19b stderr calls the answer partial', /credit cap/.test(stderrParts.join('')), stderrParts.join('').trim());
  check('19c fresh receipt carries question and max_credits', budgetReceipt.question === 'q?' && budgetReceipt.max_credits === 25, JSON.stringify(Object.keys(budgetReceipt)));

  // 11. README mirrors the exit-code table (single source: errors.ts)
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  const missing = EXIT_CODE_TABLE.map((e) => `  ${e.code}  ${e.meaning}`).filter((row) => !readme.includes(row));
  check('11 README exit-code block matches errors.ts', missing.length === 0, missing.join(' | '));

  server.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => process.exit(failures === 0 ? 0 : 1));
