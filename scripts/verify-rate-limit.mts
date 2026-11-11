/**
 * 手动验证：服务端带内负载闸 BUSY / BUDGET_EXCEEDED 的客户端处理
 * （`node --import tsx scripts/verify-rate-limit.mts`）。
 *
 * 本仓库没有测试框架；这里照 verify-retry / verify-run 的写法，用本地假 MCP 端点扮演服务端，
 * 返回与 geoly-app `src/mcp/quota/wrap.ts`（busyError / budgetExceededError）同形的结果：
 * `isError: true`，正文 = 首行人话 + 一行紧凑 JSON（含 `error` 与 `retry_after_seconds`），外挂 `_meta`。
 * 不连任何真实服务。
 *
 * 覆盖：
 *  1. BUSY 一次后恢复 → 进程内等 retry_after 后重试一次并成功（共 2 次请求）；
 *  2. BUSY 持续 → 只重试一次（恰好 2 次请求），之后 rate_limited / 退出码 4，带 retryAfter 与「约 N 秒」hint；
 *  3. BUDGET_EXCEEDED 且 retry_after ≤ 60s → 重试一次并成功；
 *  4. BUDGET_EXCEEDED 且 retry_after = 1800s → **不在进程里等**：1 次请求、立即返回，
 *     rate_limited / 退出码 4，retryAfter = 1800，hint 带「约 1800s」与 record_ids 批量引导；
 *  5. BUDGET_EXCEEDED 且 retry_after = 61s（刚过 60s 上限）→ 同样不等、1 次请求；
 *  6. GUARDED_RATE_LIMITED 的输出不变（仍无 hint）；
 *  7. 人读错误格式（What / Why / Hint）里有 retry-after 与 hint 两行；
 *  8. 端到端 `geoly call … --error-format json`：退出码 4、stdout 为空、stderr 是带 retryAfter 的 JSON。
 */
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ctx } from '../src/context.js';
import { GeolyError } from '../src/errors.js';
import { McpClient, unwrapToolResult } from '../src/mcp.js';
import { reportError } from '../src/output.js';

/** 与 wrap.ts busyError 同形的结果（retry_after 缩到 1s，免得验证脚本真睡 2s）。 */
function busyResult(tool: string, retryAfter: number) {
  const headline = `BUSY: too many concurrent tool calls for this organization (at most 4 in flight; waited up to 10s for a slot). This is a concurrency limit, not your credit quota — retry ${tool} in ~${retryAfter}s, or run fewer calls in parallel.`;
  const payload = { error: 'BUSY', tool, scope: 'org', max_in_flight: 4, reason: 'queue_timeout', retry_after_seconds: retryAfter };
  return rejected(headline, payload, 'BUSY');
}

/** 与 wrap.ts budgetExceededError 同形的结果。 */
function budgetResult(tool: string, retryAfter: number) {
  const headline = `BUDGET_EXCEEDED: this organization has used its hourly database budget (1210s of 1200s in the last 60 minutes). This is a load guard, not your credit quota — retry ${tool} in ~${retryAfter}s, or spread calls over the hour and avoid re-fetching pages you already have (data refreshes once a day).`;
  const payload = { error: 'BUDGET_EXCEEDED', tool, scope: 'org', budget_seconds: 1200, used_seconds: 1210, window_seconds: 3600, retry_after_seconds: retryAfter };
  return rejected(headline, payload, 'BUDGET_EXCEEDED');
}

/** structuredError + withMachineMeta 的简化替身：只加 `_meta`，content / isError 与服务端一致。 */
function rejected(headline: string, payload: Record<string, unknown>, code: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: `${headline}\n${JSON.stringify(payload)}` }],
    _meta: { 'geoly/quota': { charge: 'unbilled' }, 'geoly/outcome': { status: 'error', code } },
  };
}

const OK = { content: [{ type: 'text', text: '{"ok":true}' }] };
const TOOLS = ['busy_once', 'busy_always', 'budget_short', 'budget_long', 'budget_edge'].map((name) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
}));

/** 每个工具被打了几次（tools/call 粒度）。 */
const hits = new Map<string, number>();

const openSockets = new Set<Socket>();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/api/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } };
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    if (rpc.method === 'tools/list') return reply({ tools: TOOLS });
    const name = rpc.params?.name ?? '';
    const n = (hits.get(name) ?? 0) + 1;
    hits.set(name, n);
    switch (name) {
      case 'busy_once':
        return reply(n === 1 ? busyResult(name, 1) : OK);
      case 'busy_always':
        return reply(busyResult(name, 1));
      case 'budget_short':
        return reply(n === 1 ? budgetResult(name, 1) : OK);
      case 'budget_long':
        return reply(budgetResult(name, 1800));
      case 'budget_edge':
        return reply(budgetResult(name, 61));
      default:
        return reply(OK);
    }
  });
});
server.on('connection', (s) => {
  openSockets.add(s);
  s.on('close', () => openSockets.delete(s));
});

let failures = 0;
/** 打印一条 PASS/FAIL 并计数。 */
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** callTool + unwrapToolResult，把抛出的 GeolyError 接住返回；同时量耗时。 */
async function callAndUnwrap(client: McpClient, name: string): Promise<{ err?: GeolyError; value?: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    const value = unwrapToolResult(name, await client.callTool(name, {}));
    return { value, ms: Date.now() - t0 };
  } catch (err) {
    return { err: err instanceof GeolyError ? err : new GeolyError('tool_error', `non-GeolyError: ${String(err)}`), ms: Date.now() - t0 };
  }
}

/** 异步跑一个子进程，收齐 stdout / stderr 与退出码。 */
function runChild(argv: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** 依次跑全部用例。 */
async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/api/mcp`;
  // tools cache / settings 写进临时 HOME，不碰真实的 ~/.geoly
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-verify-ratelimit-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const ctx: Ctx = {
    endpoint,
    profile: 'verify-ratelimit',
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

  // 1. BUSY 一次 → 重试一次成功
  const r1 = await callAndUnwrap(client, 'busy_once');
  check('1 BUSY 一次后恢复 → 等 retry_after 重试一次并成功', !r1.err && hits.get('busy_once') === 2, `hits=${hits.get('busy_once')} ${r1.ms}ms`);

  // 2. BUSY 持续 → 只重试一次，然后退出码 4
  const r2 = await callAndUnwrap(client, 'busy_always');
  const j2 = r2.err?.toJSON() ?? {};
  check(
    '2 BUSY 持续 → 恰好 2 次请求，rate_limited / exit 4 / retryAfter=1',
    r2.err?.kind === 'rate_limited' && r2.err.exitCode === 4 && j2.retryAfter === 1 && hits.get('busy_always') === 2,
    `hits=${hits.get('busy_always')} ${r2.err?.kind}:${r2.err?.exitCode} json=${JSON.stringify(j2)}`,
  );
  check('2 BUSY hint 写明约 N 秒后再试', /about 1s/.test(r2.err?.hint ?? ''), r2.err?.hint);

  // 3. BUDGET_EXCEEDED 短等待 → 重试一次成功
  const r3 = await callAndUnwrap(client, 'budget_short');
  check('3 BUDGET_EXCEEDED retry_after=1s → 重试一次并成功', !r3.err && hits.get('budget_short') === 2, `hits=${hits.get('budget_short')} ${r3.ms}ms`);

  // 4. BUDGET_EXCEEDED 长等待 → 不等，立即退出码 4
  const r4 = await callAndUnwrap(client, 'budget_long');
  const j4 = r4.err?.toJSON() ?? {};
  check(
    '4 BUDGET_EXCEEDED retry_after=1800s → 1 次请求、立即返回（不在进程里等）',
    hits.get('budget_long') === 1 && r4.ms < 2_000,
    `hits=${hits.get('budget_long')} ${r4.ms}ms`,
  );
  check(
    '4 → rate_limited / exit 4 / retryAfter=1800（JSON 里也在）',
    r4.err?.kind === 'rate_limited' && r4.err.exitCode === 4 && r4.err.retryAfter === 1800 && j4.retryAfter === 1800 && j4.tool === 'budget_long',
    JSON.stringify(j4),
  );
  check('4 message = 服务端首行（不含 JSON 尾）', (r4.err?.message ?? '').startsWith('BUDGET_EXCEEDED: this organization has used') && !(r4.err?.message ?? '').includes('{'), r4.err?.message);
  check(
    '4 hint 含「约 1800s」与 record_ids 批量引导',
    /about 1800s/.test(r4.err?.hint ?? '') && /record_ids/.test(r4.err?.hint ?? '') && /get_prompt_record_detail/.test(r4.err?.hint ?? '') && /already have/.test(r4.err?.hint ?? ''),
    r4.err?.hint,
  );

  // 5. 刚过 60s 上限 → 也不等
  const r5 = await callAndUnwrap(client, 'budget_edge');
  check(
    '5 BUDGET_EXCEEDED retry_after=61s（> 60s 上限）→ 1 次请求、立即 exit 4',
    hits.get('budget_edge') === 1 && r5.ms < 2_000 && r5.err?.exitCode === 4 && r5.err.retryAfter === 61,
    `hits=${hits.get('budget_edge')} ${r5.ms}ms ${r5.err?.kind}`,
  );

  // 6. GUARDED_RATE_LIMITED 输出不变（无 hint）
  let guarded: GeolyError | undefined;
  try {
    unwrapToolResult('guarded', {
      isError: true,
      content: [{ type: 'text', text: 'RATE_LIMITED: guarded is capped.\n{"error":"GUARDED_RATE_LIMITED","tool":"guarded","limit_per_minute":5,"retry_after_seconds":30}' }],
    });
  } catch (err) {
    guarded = err instanceof GeolyError ? err : undefined;
  }
  check(
    '6 GUARDED_RATE_LIMITED 仍是 rate_limited / exit 4，且不带 hint（输出不变）',
    guarded?.kind === 'rate_limited' && guarded.exitCode === 4 && guarded.retryAfter === 30 && guarded.hint === undefined,
    JSON.stringify(guarded?.toJSON()),
  );

  // 7. 人读格式
  if (r4.err) {
    const parts: string[] = [];
    const ew = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      parts.push(String(s));
      return true;
    };
    let code = -1;
    try {
      code = reportError({ ...ctx, errorFormat: 'human' }, r4.err);
    } finally {
      (process.stderr as unknown as { write: typeof ew }).write = ew;
    }
    const human = parts.join('');
    check(
      '7 人读格式含 error[rate_limited] / retry-after: 1800s / hint 行，返回 4',
      code === 4 && /^error\[rate_limited\]: BUDGET_EXCEEDED:/.test(human) && /retry-after: 1800s/.test(human) && /hint: Retry the same call in about 1800s/.test(human),
      human.trim().split('\n').map((l) => l.slice(0, 90)).join(' | '),
    );
  } else {
    check('7 人读格式', false, '用例 4 没拿到错误');
  }

  // 8. 端到端：geoly call 的退出码与 stderr JSON
  const before = hits.get('budget_long') ?? 0;
  const bin = path.join(process.cwd(), 'src', 'bin.ts');
  // 必须异步 spawn：假服务端跑在本进程里，spawnSync 会堵住事件循环，子进程永远等不到回包。
  const run = await runChild([process.execPath, '--import', 'tsx', bin, 'call', 'budget_long', '--error-format', 'json'], {
    ...process.env,
    GEOLY_MCP_ENDPOINT: endpoint,
    GEOLY_TOKEN: 'geom_test',
    GEOLY_NO_AUTO_AUTH: '1',
    GEOLY_NO_AUTO_UPDATE: '1',
    HOME: tmpHome,
    USERPROFILE: tmpHome,
  });
  let e2e: Record<string, unknown> | undefined;
  try {
    e2e = JSON.parse(run.stderr.trim().split('\n').pop() ?? '') as Record<string, unknown>;
  } catch {
    e2e = undefined;
  }
  check(
    '8 geoly call budget_long --error-format json → exit 4、stdout 空、stderr JSON 带 retryAfter=1800、只打 1 次',
    run.status === 4 && run.stdout === '' && e2e?.kind === 'rate_limited' && e2e.retryAfter === 1800 && /record_ids/.test(String(e2e.hint)) && (hits.get('budget_long') ?? 0) - before === 1,
    `status=${run.status} stdout=${JSON.stringify(run.stdout)} stderr=${run.stderr.trim().slice(0, 400)}`,
  );

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
