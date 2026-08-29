/**
 * 手动验证：多组织选择器（`pnpm verify:org-picker`）。
 *
 * 这段是人第一次运行 `geoly` 时最可能撞上的分支——多组织 token 不指定组织，服务端只能
 * 回一串裸 id。选择器写错的代价是「产品第一屏就用不了」，所以把交互也跑一遍：
 * 编号选择、直接粘 id、非法输入重问、选完落盘。
 */
import { PassThrough } from 'node:stream';
import { readSettings, settingsPath } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { promptForOrg, ambiguousOrgError } from '../src/org-select.js';
import * as fs from 'node:fs';

const ORGS = [
  { org_id: 'borg_aaa', name: 'Anker', role: 'admin' },
  { org_id: 'borg_bbb', name: 'Plaud US', role: 'admin' },
  { org_id: 'borg_ccc', name: 'Rijoy', role: 'owner' },
];

const PROFILE = 'verify-picker';
const ctx = { profile: PROFILE } as Ctx;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Feed the picker a scripted answer and collect what it printed. */
async function pick(answers: string[]): Promise<{ chosen: string; out: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => {
    out += String(c);
  });
  const promise = promptForOrg(ctx, ORGS, { input, output });
  // readline needs the prompt written before the answer arrives
  for (const a of answers) {
    await new Promise((r) => setTimeout(r, 30));
    input.write(`${a}\n`);
  }
  const chosen = await promise;
  return { chosen, out };
}

function reset() {
  try {
    fs.unlinkSync(settingsPath(PROFILE));
  } catch {
    // 没有就算了
  }
}

// 1. 按编号选
reset();
{
  const { chosen, out } = await pick(['2']);
  check(
    '按编号选 → 选中对应组织并落盘',
    chosen === 'borg_bbb' && readSettings(PROFILE).defaultOrg === 'borg_bbb',
    `chosen=${chosen} saved=${readSettings(PROFILE).defaultOrg}`,
  );
  check('列表里带出组织名字（不是一串裸 id）', out.includes('Plaud US') && out.includes('Anker'));
}

// 2. 直接粘 id（多组织用户常常已经知道要哪个）
reset();
{
  const { chosen } = await pick(['borg_ccc']);
  check('粘贴 org id → 也认', chosen === 'borg_ccc' && readSettings(PROFILE).defaultOrg === 'borg_ccc');
}

// 3. 非法输入不能把人踢出去
reset();
{
  const { chosen, out } = await pick(['99', 'zzz', '1']);
  check(
    '非法输入 → 重问而不是崩溃/退出',
    chosen === 'borg_aaa' && /enter 1-3/.test(out),
    `chosen=${chosen}`,
  );
}

// 4. 只有一个组织时不该打扰人
reset();
{
  const only = [ORGS[0]!];
  const chosen = await promptForOrg(ctx, only, {
    input: new PassThrough(),
    output: new PassThrough(),
  });
  check('只有一个组织 → 直接用，不弹选择', chosen === 'borg_aaa');
}

// 5. 非交互路径：报错里必须有名字
{
  const err = ambiguousOrgError(ORGS);
  check(
    '非交互 → 报错带组织名字与 --org 提示',
    err.message.includes('Rijoy') && (err.hint ?? '').includes('--org'),
  );
}

reset();
process.exit(failures === 0 ? 0 : 1);
