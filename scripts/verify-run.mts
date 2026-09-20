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
 * 14. a replayed `failed` record exits 1 like a live failure; raw-mode replay prints the answer.
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
import { emitOutcome } from '../src/commands/run.js';
import { completeRemoteLogin } from '../src/oauth.js';
import { pendingAuthPath, writeJson, credentialsPath, readJson } from '../src/config.js';

type Mode = 'done' | 'slow' | 'replay' | 'fail' | 'lateStart' | 'replayFailed';
let mode: Mode = 'done';
let seenIdempotencyKey: string | undefined;
let pollCount = 0;
let rpcCalls = 0;
let guardedServed = false;
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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
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
      res.writeHead(200, { 'content-type': 'application/json' });
      if (rpc.method === 'tools/call' && rpc.params?.name === 'bad_params') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Invalid arguments: time_range' } }));
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
  check('14b raw replay prints the answer then the run id', out.join('') === 'earlier answer\nrun_replay1\n', JSON.stringify(out.join('')));

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
