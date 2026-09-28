/**
 * Verifies background auto-update without touching the real ~/.geoly or any installed binary.
 *
 *   node --import tsx scripts/verify-auto-update.mts            # unit checks (offline)
 *   GEOLY_VERIFY_SWAP=1 node --import tsx scripts/verify-auto-update.mts
 *     # + real swap: copies node to <tmp>/geoly(.exe), re-runs this script under that copy so
 *     #   process.execPath "is" a released binary, installs the published release over itself
 *     #   while running, then runs the swapped file with --version. Needs github.com reachable.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-autoupdate-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const self = await import('../src/selfupdate.js');
const config = await import('../src/config.js');
check('GEOLY_DIR is sandboxed', config.GEOLY_DIR.startsWith(home), config.GEOLY_DIR);

if (process.env.GEOLY_VERIFY_SWAP_CHILD) {
  // Running as <tmp>/geoly(.exe): install the published release over our own image.
  const manifest = await self.fetchManifest(20_000);
  const r = await self.installRelease(manifest, (m) => console.log(m));
  console.log(`SWAPPED ${r.path} -> v${r.to}`);
  process.exit(0);
}

// ---- off switches ---------------------------------------------------------
const reason = self.autoUpdateDisabledReason;
check('opt-out env wins', reason({ GEOLY_NO_AUTO_UPDATE: '1' }) === 'GEOLY_NO_AUTO_UPDATE is set');
check('opt-out "false" is not opt-out', reason({ GEOLY_NO_AUTO_UPDATE: 'false' }) !== 'GEOLY_NO_AUTO_UPDATE is set');
check('CI disables', reason({ CI: 'true' }) === 'running in CI');
check('CI=false does not', reason({ CI: 'false' }) !== 'running in CI');
check('child never re-spawns', reason({ [self.AUTO_UPDATE_CHILD_ENV]: '1' }) === 'already the auto-update child');
check('dev checkout (node) is off', reason({}) === 'not a compiled install', String(reason({})));

// ---- lock -----------------------------------------------------------------
const release = self.acquireUpdateLock();
check('lock acquired', typeof release === 'function');
check('second acquire refused while held', self.acquireUpdateLock() === undefined);
release?.();
const again = self.acquireUpdateLock();
check('re-acquire after release', typeof again === 'function');
const lockPath = path.join(config.GEOLY_DIR, 'upgrade.lock');
const old = new Date(Date.now() - 11 * 60 * 1000);
fs.utimesSync(lockPath, old, old);
const stolen = self.acquireUpdateLock();
check('stale lock (>10 min) is taken over', typeof stolen === 'function');
stolen?.();

// ---- marker ---------------------------------------------------------------
self.writeAutoUpdateMarker({ from: '0.3.2', to: '0.3.3', at: new Date().toISOString() });
const m = self.takeAutoUpdateMarker();
check('marker read once', m?.to === '0.3.3' && m?.from === '0.3.2');
check('marker removed after read', self.takeAutoUpdateMarker() === undefined);

// ---- daily check under a dev checkout off a TTY: silent no-op --------------
const { maybeNotifyUpdate } = await import('../src/updatecheck.js');
await maybeNotifyUpdate();
check('no stamp written when auto-update is off and no TTY', !fs.existsSync(config.LAST_UPDATE_CHECK_PATH));

// ---- real swap (opt-in) -----------------------------------------------------
if (process.env.GEOLY_VERIFY_SWAP) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-swap-'));
  const fake = path.join(binDir, process.platform === 'win32' ? 'geoly.exe' : 'geoly');
  fs.copyFileSync(process.execPath, fake);
  fs.writeFileSync(path.join(binDir, '.geoly-old-99999'), 'leftover');
  const tsx = path.resolve('node_modules/tsx/dist/esm/index.mjs');
  const child = spawnSync(fake, ['--import', `file://${tsx.replace(/\\/g, '/')}`, path.resolve('scripts/verify-auto-update.mts')], {
    env: { ...process.env, GEOLY_VERIFY_SWAP_CHILD: '1', NODE_USE_ENV_PROXY: '1' },
    encoding: 'utf8',
  });
  console.log(child.stdout.trim().split('\n').map((l) => `  | ${l}`).join('\n'));
  if (child.stderr.trim()) console.log(child.stderr.trim().split('\n').slice(-5).map((l) => `  ! ${l}`).join('\n'));
  check('swap child exited 0', child.status === 0, `status ${child.status}`);
  const ver = spawnSync(fake, ['--version'], { encoding: 'utf8' });
  check('swapped file is the published geoly binary', /^\d+\.\d+\.\d+/.test(ver.stdout.trim()), JSON.stringify(ver.stdout.trim()));
  check('stale .geoly-old-* image swept', !fs.existsSync(path.join(binDir, '.geoly-old-99999')));
}

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
