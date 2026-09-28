/**
 * Offline verification of the client deadline (`node --import tsx scripts/verify-timeout.mts`).
 * A local fake MCP endpoint + Agent API plays the server.
 *
 * Covers:
 *  1. deadline derivation — server budget + 15 s, 60 s when unknown, `--timeout` can lengthen
 *     but never cut below the server budget, capped at the --timeout maximum;
 *  2. `_meta["geoly/timeoutMs"]` parsing (bad values ignored);
 *  3. deadline firing MID-BODY (SSE headers sent, frame never comes) → kind `timeout`, exit 6,
 *     with the deadline and the server budget in the JSON error — not "Could not parse";
 *  4. deadline firing before the headers → kind `timeout`;
 *  5. deadline firing while a JSON body is half-sent → kind `timeout`;
 *  6. a body that arrived but is garbage → still `upstream_unavailable: Could not parse…`;
 *  7. a server TOOL_TIMEOUT that takes longer than a short `--timeout` but fits the advertised
 *     budget is received and shown verbatim, with retryAfter (the production failure);
 *  8. a fresh client that did not list tools reads the budget from the on-disk tools cache;
 *  9. `geoly runs wait`'s GET aborted mid-body → kind `timeout`, not a raw `tool_error`;
 * 10. the "truncated by the server" warning fires only on the real marker (`_truncated: true`),
 *     not on a `_truncated` counts object some tools return with a complete answer.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ctx } from '../src/context.js';
import { GeolyError } from '../src/errors.js';
import {
  CALL_DEFAULT_TIMEOUT_MS,
  SERVER_BUDGET_GRACE_MS,
  advertisedBudgetMs,
  toolDeadlineMs,
} from '../src/deadline.js';
import { McpClient, unwrapToolResult } from '../src/mcp.js';
import { getRun } from '../src/runs.js';
import { truncationWarning } from '../src/commands/call.js';

const TOOL_TIMEOUT_TEXT =
  'TOOL_TIMEOUT: server_timeout timed out and was fully refunded. Narrow the time window / reduce scope, or retry the SAME call once after ~60s.\n' +
  '{"error":"TOOL_TIMEOUT","tool":"server_timeout","charge":"refunded","retry_after_seconds":60}';

const TOOLS = [
  { name: 'slow_sse', inputSchema: { type: 'object', properties: {} }, _meta: { 'geoly/timeoutMs': 45_000 } },
  { name: 'server_timeout', inputSchema: { type: 'object', properties: {} }, _meta: { 'geoly/timeoutMs': 800 } },
  { name: 'unadvertised', inputSchema: { type: 'object', properties: {} } },
];

const openSockets = new Set<import('node:net').Socket>();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && url.pathname === '/api/agent/runs/run_slowbody') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"run_id":"run_slowbody","status":'); // …and nothing more
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } };
    const name = rpc.params?.name;
    if (rpc.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: TOOLS } }));
      return;
    }
    if (name === 'slow_sse') {
      // What the real server does: SSE headers at once, the frame only when the tool finishes.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      return;
    }
    if (name === 'hang_headers') return; // never answers at all
    if (name === 'slow_json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0",');
      return;
    }
    if (name === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>502 Bad gateway</html>');
      return;
    }
    if (name === 'server_timeout') {
      // Longer than the user's short --timeout, within the advertised budget + grace.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => {
        const frame = { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: TOOL_TIMEOUT_TEXT }] } };
        res.end(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
      }, 1_000);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
  });
});
server.on('connection', (s) => {
  openSockets.add(s);
  s.on('close', () => openSockets.delete(s));
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function caught(p: Promise<unknown>): Promise<GeolyError | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof GeolyError ? err : new GeolyError('tool_error', `non-GeolyError: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  // 1. derivation
  const d = (override: number | undefined, budget: number | undefined) => toolDeadlineMs({ timeoutOverrideMs: override }, budget);
  check('1a budget 45s, no --timeout → 60s', d(undefined, 45_000) === 45_000 + SERVER_BUDGET_GRACE_MS);
  check('1b unknown budget, no --timeout → 60s default', d(undefined, undefined) === CALL_DEFAULT_TIMEOUT_MS && CALL_DEFAULT_TIMEOUT_MS === 60_000);
  check('1c --timeout 10 cannot cut below the server budget', d(10_000, 45_000) === 60_000);
  check('1d --timeout 200 lengthens past the budget', d(200_000, 45_000) === 200_000);
  check('1e unknown budget → --timeout as given', d(20_000, undefined) === 20_000);
  check('1f absurd server budget capped at 300s', d(undefined, 3_600_000) === 300_000);

  // 2. _meta parsing
  check('2a numeric budget read', advertisedBudgetMs({ _meta: { 'geoly/timeoutMs': 50_000 } }) === 50_000);
  check(
    '2b bad values ignored',
    [undefined, {}, { 'geoly/timeoutMs': '45000' }, { 'geoly/timeoutMs': -1 }, { 'geoly/timeoutMs': Number.NaN }].every(
      (m) => advertisedBudgetMs({ _meta: m }) === undefined,
    ),
  );

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-verify-timeout-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const ctx: Ctx = {
    endpoint: `http://127.0.0.1:${port}/api/mcp`,
    profile: 'verify-timeout',
    output: 'json',
    errorFormat: 'json',
    quiet: true,
    timeoutMs: 5_000,
    noAutoAuth: true,
    noBrowser: true,
    remote: false,
    staticToken: 'geom_test',
  };
  const client = new McpClient(ctx);

  // 3. mid-body abort
  const t3 = Date.now();
  const mid = await caught(
    client.request('tools/call', { name: 'slow_sse', arguments: {} }, { tool: 'slow_sse', timeoutMs: 300, serverBudgetMs: 45_000 }),
  );
  const json3 = mid?.toJSON() ?? {};
  check(
    '3a SSE headers then silence → kind timeout, exit 6, within the deadline',
    mid?.kind === 'timeout' && mid.exitCode === 6 && Date.now() - t3 < 2_000,
    `${mid?.kind}: ${mid?.message}`,
  );
  check('3b message names the deadline and the server budget, not a parse error', /within 0\.3s/.test(mid?.message ?? '') && /up to 45s server-side/.test(mid?.message ?? '') && !/parse/i.test(mid?.message ?? ''), mid?.message);
  check('3c --error-format json carries kind + deadline + budget', json3.kind === 'timeout' && json3.deadlineSeconds === 0.3 && json3.serverBudgetSeconds === 45 && json3.tool === 'slow_sse', JSON.stringify(json3));

  // 4. before headers
  const before = await caught(client.request('tools/call', { name: 'hang_headers', arguments: {} }, { tool: 'hang_headers', timeoutMs: 300 }));
  check('4 no headers → kind timeout', before?.kind === 'timeout' && before.exitCode === 6, `${before?.kind}: ${before?.message}`);

  // 5. half-sent JSON body
  const half = await caught(client.request('tools/call', { name: 'slow_json', arguments: {} }, { tool: 'slow_json', timeoutMs: 300 }));
  check('5 JSON body stalls mid-way → kind timeout', half?.kind === 'timeout', `${half?.kind}: ${half?.message}`);

  // 6. genuine parse failure keeps its classification
  const garbage = await caught(client.request('tools/call', { name: 'garbage', arguments: {} }, { tool: 'garbage', timeoutMs: 2_000 }));
  check('6 garbage body → upstream_unavailable "Could not parse"', garbage?.kind === 'upstream_unavailable' && /Could not parse/.test(garbage.message), `${garbage?.kind}: ${garbage?.message}`);

  // 7. the production case: --timeout shorter than the server's answer, budget advertised
  const shortCtx: Ctx = { ...ctx, timeoutMs: 300, timeoutOverrideMs: 300 };
  const listing = new McpClient(shortCtx);
  await listing.listTools(true);
  const serverTimeout = await caught(listing.callTool('server_timeout', {}).then((r) => unwrapToolResult('server_timeout', r)));
  check(
    '7a server TOOL_TIMEOUT (1s) received despite --timeout 0.3 — deadline follows the advertised budget',
    serverTimeout?.kind === 'upstream_unavailable' && serverTimeout.retryAfter === 60,
    `${serverTimeout?.kind}: ${serverTimeout?.message}`,
  );
  check('7b server prose shown verbatim', (serverTimeout?.message ?? '').startsWith('TOOL_TIMEOUT: server_timeout timed out and was fully refunded. Narrow the time window'), serverTimeout?.message);
  check('7c hint carries the server retry-after', /after 60s/.test(serverTimeout?.hint ?? ''), serverTimeout?.hint);

  // 8. budget from the on-disk cache on a client that never listed tools
  const fresh = new McpClient(shortCtx);
  const viaCache = await caught(fresh.callTool('server_timeout', {}).then((r) => unwrapToolResult('server_timeout', r)));
  check('8 fresh client uses the cached budget', viaCache?.kind === 'upstream_unavailable' && viaCache.retryAfter === 60, `${viaCache?.kind}: ${viaCache?.message}`);

  // 9. Agent API GET aborted mid-body
  const run = await caught(getRun({ ...ctx, timeoutMs: 300 }, 'run_slowbody'));
  check('9 runs wait GET stalls mid-body → kind timeout (not tool_error)', run?.kind === 'timeout' && run.exitCode === 6, `${run?.kind}: ${run?.message}`);

  // 10. truncation marker
  check('10a real server truncation warns, with counts', /truncated by the server \(20 of 350 shown\)/.test(truncationWarning({ _truncated: true, _totalCount: 350, _shownCount: 20, _message: 'm', items: [] }) ?? ''));
  check('10b _truncated counts object (complete answer) → no warning', truncationWarning({ record: {}, _truncated: { citations: 120, searchSources: 40 } }) === undefined);
  check('10c hasMore still hinted', /more rows available/.test(truncationWarning({ hasMore: true }) ?? ''));

  for (const s of openSockets) s.destroy();
  server.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => process.exit(failures === 0 ? 0 : 1));
