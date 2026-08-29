/**
 * 手动验证：方向键选择器（`pnpm verify:picker`）。
 *
 * 这段没有 TTY 就跑不到，而它是产品第一屏。用一个假的 raw-mode 输入流把按键喂进去：
 * 上下移动、循环、打字过滤、回车确认、Esc 取消、滚动窗口。
 */
import { PassThrough } from 'node:stream';
import { canPick, pickFromList } from '../src/select.js';

const ORGS = [
  'Anker', 'babeside', 'Casely', 'Custype', 'eufy', 'geoly', 'hbada', 'jackery',
  'mewaii', 'Neewer', 'Plaud US', 'Rijoy', 'roborock', 'Soundcore', 'torras', 'xTool',
].map((name, i) => ({ value: `org_${i}`, label: name, detail: `(org_${i})` }));

/** PassThrough 不是 TTY，补上 setRawMode 让选择器认为自己可以工作。 */
function fakeTty() {
  const s = new PassThrough() as PassThrough & { setRawMode?: (m: boolean) => void };
  s.setRawMode = () => {};
  return s;
}

const KEY = {
  down: '\x1b[B',
  up: '\x1b[A',
  enter: '\r',
  esc: '\x1b',
  end: '\x1b[F',
};

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function drive(keys: string[]): Promise<{ chosen: string | undefined; out: string }> {
  const input = fakeTty();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => {
    out += String(c);
  });
  const promise = pickFromList(ORGS, { title: 'Which organization?', input, output });
  for (const k of keys) {
    await new Promise((r) => setTimeout(r, 15));
    input.write(k);
  }
  return { chosen: await promise, out };
}

check('管道流不具备 raw 模式 → 选择器自知不可用（调用方回落）', !canPick(new PassThrough()));
check('假 TTY → 选择器认为可用', canPick(fakeTty()));

// 1. 直接回车 = 选中第一项
{
  const { chosen } = await drive([KEY.enter]);
  check('回车 → 选中当前项（默认第一项）', chosen === 'org_0', `chosen=${chosen}`);
}

// 2. 向下移动
{
  const { chosen } = await drive([KEY.down, KEY.down, KEY.enter]);
  check('↓↓ 回车 → 选中第三项', chosen === 'org_2', `chosen=${chosen}`);
}

// 3. 在第一项上按 ↑ 回环到末项（长列表里很省事）
{
  const { chosen } = await drive([KEY.up, KEY.enter]);
  check('首项按 ↑ → 回环到末项', chosen === `org_${ORGS.length - 1}`, `chosen=${chosen}`);
}

// 4. 打字过滤——33 个组织时这才是真正好用的那条路
{
  const { chosen, out } = await drive(['r', 'i', 'j', KEY.enter]);
  check('打字过滤 → 直达 Rijoy', chosen === 'org_11', `chosen=${chosen}`);
  check('过滤词回显在标题上', /\/rij/.test(out));
}

// 5. 过滤后再移动
{
  const { chosen } = await drive(['a', KEY.down, KEY.enter]);
  // 含 a 的：Anker(0) babeside(1) Casely(2) Custype(3) hbada(6) jackery(7) mewaii(8) Plaud US(10)
  check('过滤后 ↓ 仍在过滤结果里移动', chosen === 'org_1', `chosen=${chosen}`);
}

// 6. Esc 取消
{
  const { chosen } = await drive([KEY.esc]);
  check('Esc → 取消，不返回任何选择', chosen === undefined, `chosen=${chosen}`);
}

// 7. 长列表只画一个窗口，并给出位置提示
{
  const { out } = await drive([KEY.esc]);
  const shown = ORGS.filter((o) => out.includes(o.label)).length;
  check('长列表只渲染一个窗口，不是全量刷屏', shown <= 13, `渲染了 ${shown}/${ORGS.length} 行`);
  check('带位置提示（x/N）', /1\/16/.test(out), out.includes('1/16') ? '' : '缺少 1/16');
}

process.exit(failures === 0 ? 0 : 1);
