#!/usr/bin/env node
/**
 * One-command local release (we don't use GitHub Actions):
 *   node scripts/release.mjs [--dry-run]
 *
 * Does exactly what .github/workflows/release.yml would:
 *   version guard → esbuild bundle → bun cross-compile 7 targets →
 *   gzip + sha256 → manifest.json → `gh release create v<version>`.
 *
 * Windows host note: bun's own cross-target downloader is broken on Windows
 * ("Failed to extract executable"), so this script pre-seeds
 * ~/.bun/install/cache/ by downloading the target runtimes itself
 * (curl + unzip, both ship with Git Bash).
 */
import { execFileSync, execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const REPO = 'geoly-ai/GEOly-Cli';
const DRY_RUN = process.argv.includes('--dry-run');

/** target-triple → bun runtime zip base name (arm64 zips are named aarch64). */
const TARGETS = {
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-aarch64',
  'linux-x64': 'bun-linux-x64',
  'linux-x64-baseline': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-aarch64',
  'windows-x64': 'bun-windows-x64',
  'windows-x64-baseline': 'bun-windows-x64-baseline',
};

function sh(cmd, opts = {}) {
  const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', cwd: ROOT, ...opts });
  return out == null ? '' : out.toString().trim(); // stdout:'ignore' yields null
}

function findBun() {
  try {
    sh(process.platform === 'win32' ? 'where bun' : 'command -v bun');
    return 'bun';
  } catch {
    const local = path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (fs.existsSync(local)) return local;
    throw new Error('bun not found — install it first: https://bun.sh');
  }
}

/** Read the single-source version and refuse to double-release it. */
function resolveVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'version.ts'), 'utf8');
  const version = src.match(/VERSION = '([^']+)'/)?.[1];
  if (!version) throw new Error('could not parse VERSION from src/version.ts');
  try {
    execFileSync('gh', ['release', 'view', `v${version}`, '--repo', REPO], { stdio: 'ignore' });
    throw new Error(`v${version} is already released — bump VERSION in src/version.ts first`);
  } catch (err) {
    if (String(err.message).includes('already released')) throw err;
    return version; // gh exits non-zero when the release doesn't exist — good
  }
}

/** Windows workaround: pre-download target runtimes into bun's cache. */
function seedBunCache(bun) {
  if (process.platform !== 'win32') return; // bun's own downloader works elsewhere
  const bunVersion = sh(`"${bun}" --version`);
  const cacheDir = path.join(os.homedir(), '.bun', 'install', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-release-'));
  for (const zipBase of Object.values(TARGETS)) {
    const cacheFile = path.join(cacheDir, `${zipBase}-v${bunVersion}`);
    if (fs.existsSync(cacheFile)) continue;
    console.log(`==> seeding bun runtime: ${zipBase}`);
    const zip = path.join(tmp, `${zipBase}.zip`);
    sh(`curl -fsSL --retry 3 -o "${zip}" "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${zipBase}.zip"`);
    sh(`unzip -o -q "${zip}" -d "${tmp}"`);
    const inner = path.join(tmp, zipBase, zipBase.startsWith('bun-windows') ? 'bun.exe' : 'bun');
    fs.copyFileSync(inner, cacheFile);
    if (zipBase.startsWith('bun-windows')) fs.copyFileSync(inner, `${cacheFile}.exe`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function main() {
  const status = sh('git status --porcelain');
  if (status) throw new Error(`working tree is not clean — commit first:\n${status}`);
  const version = resolveVersion();
  const bun = findBun();
  console.log(`==> releasing v${version} (bun ${sh(`"${bun}" --version`)})`);

  seedBunCache(bun);

  console.log('==> bundling (esbuild, no sourcemap)');
  sh('node build.mjs');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const manifestFiles = [];
  for (const [target, _zipBase] of Object.entries(TARGETS)) {
    console.log(`==> compiling bun-${target}`);
    const isWin = target.startsWith('windows-');
    const rawOut = path.join(OUT, `geoly-${target}${isWin ? '.exe' : ''}`);
    sh(`"${bun}" build dist/bin.js --compile --target="bun-${target}" --outfile "${rawOut}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
    const gz = zlib.gzipSync(fs.readFileSync(rawOut), { level: 9 });
    const assetName = `geoly-${target}.gz`;
    fs.writeFileSync(path.join(OUT, assetName), gz);
    fs.rmSync(rawOut);
    const [, osName, arch] = assetName.match(/^geoly-(darwin|linux|windows)-(.+)\.gz$/);
    manifestFiles.push({
      os: osName,
      arch,
      url: `https://github.com/${REPO}/releases/download/v${version}/${assetName}`,
      sha256: crypto.createHash('sha256').update(gz).digest('hex'),
    });
  }

  const manifest = {
    latest: version,
    published_at: new Date().toISOString(),
    files: manifestFiles,
    rollback_versions: [],
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`==> manifest.json: ${manifestFiles.length} assets`);

  if (DRY_RUN) {
    console.log('==> dry run — skipping gh release create. Assets in out/');
    return;
  }
  console.log(`==> creating GitHub release v${version}`);
  const assets = fs.readdirSync(OUT).map((f) => path.join(OUT, f));
  execFileSync(
    'gh',
    [
      'release', 'create', `v${version}`, ...assets,
      '--repo', REPO,
      '--title', `GEOly CLI v${version}`,
      '--notes',
      'Install: `curl -fsSL https://geoly.ai/install.sh | sh` (Windows: `irm https://geoly.ai/install.ps1 | iex`). ' +
        'Mirror: raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.sh. All assets sha256-pinned in manifest.json.',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
  console.log(`==> done: https://github.com/${REPO}/releases/tag/v${version}`);
  console.log('==> reminder: git push the version-bump commit and tag if not already pushed.');
}

main();
