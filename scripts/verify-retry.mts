/**
 * 手动验证：agent 一跳的重试边界（`node --import tsx scripts/verify-retry.mts`）。
 *
 * 本仓库没有测试框架，而重试逻辑一旦写错的代价很实在——要么整轮运行被一次抖动打死，
 * 要么半截流被重发导致重复输出 + 双份计费。所以用一个本地假网关把两侧边界都跑一遍。
 *
 * 覆盖四条：
 *  1. 首字节前的 503 → 自动重试并成功；
 *  2. 持续 503 → 试满次数后才报错；
 *  3. 402 INSUFFICIENT_CREDITS → 不重试，且与「没订阅」区分开；
 *  4. **已经吐出字节后**上游断掉 → 绝不重试（重发 = 重复输出 + 双份计费）。
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamCompletion } from '../src/agent.js';
import type { Ctx } from '../src/context.js';
import { GeolyError } from '../src/errors.js';

const SSE =
  'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}\n\n';

type Mode = 'flaky' | 'always503' | 'nocredits' | 'dieMidStream';

let mode: Mode = 'flaky';
let hits = 0;

const server = createServer((req, res) => {
  hits++;
  if (mode === 'always503') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'MODEL_ERROR', status: 503 }));
    return;
  }
  if (mode === 'nocredits') {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'INSUFFICIENT_CREDITS',
        remaining: 0,
        period_end: '2026-09-01T00:00:00.000Z',
      }),
    );
    return;
  }
  if (mode === 'dieMidStream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    // 必须等客户端真的把这段收下去再断，否则 undici 可能在交付 header 之前就把
    // fetch 直接 reject 掉——那种情况客户端一个字节都没拿到，重试反而是对的，
    // 测不到「已交付后不得重试」这条边界。
    setTimeout(() => res.destroy(), 300);
    return;
  }
  // flaky：前两次 503，第三次成功
  if (hits < 3) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'MODEL_ERROR', status: 503 }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(SSE);
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const ctx: Ctx = {
  endpoint: `http://127.0.0.1:${port}/api/mcp`,
  profile: 'test',
  output: 'json',
  errorFormat: 'json',
  quiet: true,
  timeoutMs: 30_000,
  noAutoAuth: true,
  noBrowser: true,
  staticToken: 'geom_test',
};

async function run() {
  const chunks: string[] = [];
  for await (const c of streamCompletion(ctx, {
    brandId: 'brand_x',
    input: [{ role: 'user', content: 'hi' }],
  })) {
    if (c.type === 'text') chunks.push(c.text);
  }
  return chunks.join('');
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// 1. 首字节前的 503 → 重试后成功
mode = 'flaky';
hits = 0;
try {
  const text = await run();
  check('瞬时 503 → 自动重试并成功', text === 'hi' && hits === 3, `hits=${hits} text=${text}`);
} catch (e) {
  check('瞬时 503 → 自动重试并成功', false, String(e));
}

// 2. 持续 503 → 试满才报错
mode = 'always503';
hits = 0;
try {
  await run();
  check('持续 503 → 试满次数后报错', false, '竟然成功了');
} catch (e) {
  const err = e as GeolyError;
  check(
    '持续 503 → 试满次数后报错',
    err.kind === 'upstream_unavailable' && hits === 3,
    `hits=${hits} kind=${err.kind}`,
  );
}

// 3. 额度耗尽 → 不重试，且与「没订阅」区分
mode = 'nocredits';
hits = 0;
try {
  await run();
  check('额度耗尽 → 不重试且分类正确', false, '竟然成功了');
} catch (e) {
  const err = e as GeolyError;
  check(
    '额度耗尽 → 不重试且分类正确',
    err.kind === 'quota_exhausted' && hits === 1,
    `hits=${hits} kind=${err.kind} hint=${err.hint ?? ''}`,
  );
}

// 4. 已经吐字节后断开 → 绝不重试
mode = 'dieMidStream';
hits = 0;
try {
  await run();
  check('流已开始后断开 → 不重试', hits === 1, `hits=${hits}（正常结束）`);
} catch (e) {
  check('流已开始后断开 → 不重试', hits === 1, `hits=${hits} err=${(e as Error).message}`);
}

server.close();
process.exit(failures === 0 ? 0 : 1);
