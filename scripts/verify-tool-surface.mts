/**
 * Offline verification of the 0.7.0 tool-surface follow-ups (`node --import tsx scripts/verify-tool-surface.mts`).
 * Nothing leaves the machine: `fetch` is stubbed for the skill/release channels and a local fake MCP
 * endpoint plays the server for the `geoly call` runs. ~/.geoly and the agent hosts live in a temp HOME.
 *
 * Covers:
 *  1. skill downgrade guard — an embedded bundle never overwrites a newer installed skill (kept,
 *     stderr says why); a live bundle always replaces; embedded newer / fresh installs still write;
 *     the real offline fallback (loadSkillBundle with the network down) keeps a newer install;
 *  2. background refresh without a new binary — `backgroundUpdate` (the body of `upgrade --auto`)
 *     rewrites only hosts that are behind, never installs into a host without the skill, leaves
 *     current hosts alone, fetches the zip only when needed, carries on when the release channel
 *     is down, gives up quietly when app.geoly.ai is down or the zip does not verify, and every
 *     request is bounded (a hanging skill manifest is cut at its 5 s timeout);
 *  3. resident tool names — CORE_TOOL_NAMES = the server's RESIDENT_NAMES (2026-09-29) + the two
 *     MCP selectors, and holds no removed name;
 *  4. removed tool names — the table covers all 34 (16 brand-own + 18 public); `geoly call` /
 *     `geoly schema` on one exits 2 with the replacement call in the hint, also when a stale tool
 *     list sent the call and the server answered "Tool … not found" (JSON-RPC error frame or
 *     in-band isError); other unknown names keep the typo suggestion; the local agent's find_tools
 *     ranks the replacement first and explains the old name, and a direct call to an old name
 *     answers with the replacement (loaded into the tool list) without a round trip.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geoly-toolsurface-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
// A hung await must not hang the verification.
const watchdog = setTimeout(() => {
  console.log('FAIL  watchdog: verification did not finish within 90s');
  process.exit(1);
}, 90_000);

const { GeolyError } = await import('../src/errors.js');
const skills = await import('../src/skills.js');
const { backgroundUpdate } = await import('../src/commands/upgrade.js');
const { isCompiledInstall } = await import('../src/selfupdate.js');
const { VERSION, resolveManifestUrl } = await import('../src/version.js');
const { CORE_TOOL_NAMES, searchCatalog } = await import('../src/tool-catalog.js');
const { REMOVED_TOOLS } = await import('../src/removed-tools.js');
const { unknownToolError } = await import('../src/commands/tools.js');
const { AgentSession } = await import('../src/loop.js');
const { Workspace } = await import('../src/workspace.js');
type Ctx = import('../src/context.js').Ctx;
type SkillBundle = import('../src/skills.js').SkillBundle;

// backgroundUpdate would swap process.execPath if it ever saw a newer release; under a compiled
// `geoly` binary that is a real install. Refuse — this script only runs under node.
if (isCompiledInstall()) {
  console.log('FAIL  refusing to run under a compiled geoly binary');
  process.exit(1);
}

const skillMd = (version: string, marker = '') => Buffer.from(`---\nname: geoly-mcp\nmetadata:\n  version: "${version}"\n---\n${marker}`);
const skillDir = (hostDir: string) => path.join(home, hostDir, 'skills', 'geoly-mcp');
const readSkill = (hostDir: string) => {
  try {
    return fs.readFileSync(path.join(skillDir(hostDir), 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
};
const seedSkill = (hostDir: string, version: string, marker = '') => {
  fs.mkdirSync(skillDir(hostDir), { recursive: true });
  fs.writeFileSync(path.join(skillDir(hostDir), 'SKILL.md'), skillMd(version, marker));
};
const resetHome = () => {
  for (const d of ['.claude', '.codex', '.cursor', '.geoly']) fs.rmSync(path.join(home, d), { recursive: true, force: true });
};
const bundle = (version: string, source: 'live' | 'embedded'): SkillBundle => ({
  version,
  source,
  files: [
    { rel: 'SKILL.md', data: skillMd(version, `from ${source} ${version}`) },
    { rel: 'references/tools-catalog.md', data: Buffer.from(`catalog ${version}`) },
  ],
});

/** Collect what a block writes to stderr. */
async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ value: T; err: string }> {
  const parts: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    parts.push(String(s));
    return true;
  };
  try {
    return { value: await fn(), err: parts.join('') };
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
  }
}

// ---- 1. downgrade guard ----------------------------------------------------------------------
{
  resetHome();
  const claude = skills.AGENT_HOSTS.find((h) => h.id === 'claude-code')!;
  seedSkill('.claude', '0.7.0', 'installed-0.7.0');

  const kept = await captureStderr(() => skills.installSkill(claude, bundle('0.6.1', 'embedded'), home));
  check('1a embedded 0.6.1 over installed 0.7.0 → kept, nothing written', kept.value.kept === true && kept.value.files === 0 && /installed-0\.7\.0/.test(readSkill('.claude') ?? ''));
  check('1a reports the kept version', kept.value.version === '0.7.0' && kept.value.previous === '0.7.0', JSON.stringify(kept.value));
  check('1a stderr says why', /kept skill 0\.7\.0 in Claude Code/.test(kept.err) && /embedded 0\.6\.1/.test(kept.err), kept.err);

  const live = await captureStderr(() => skills.installSkill(claude, bundle('0.6.1', 'live'), home));
  check('1b live 0.6.1 over installed 0.7.0 → written (the server copy always wins)', !live.value.kept && /from live 0\.6\.1/.test(readSkill('.claude') ?? '') && live.err === '');

  const newer = skills.installSkill(claude, bundle('0.8.0', 'embedded'), home);
  check('1c embedded 0.8.0 over installed 0.6.1 → written', !newer.kept && newer.version === '0.8.0' && /from embedded 0\.8\.0/.test(readSkill('.claude') ?? ''));

  const same = skills.installSkill(claude, bundle('0.8.0', 'embedded'), home);
  check('1d embedded equal to installed → rewritten (not newer, not kept)', !same.kept && same.files === 2);

  const codex = skills.AGENT_HOSTS.find((h) => h.id === 'codex')!;
  const fresh = skills.installSkill(codex, bundle('0.6.1', 'embedded'), home);
  check('1e embedded into a host without the skill → written', !fresh.kept && /from embedded 0\.6\.1/.test(readSkill('.codex') ?? ''));

  // The real offline path: live channel down → the binary's own embedded bundle.
  seedSkill('.claude', '99.0.0', 'installed-99');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed (offline)');
  }) as typeof fetch;
  try {
    const ctx = { endpoint: 'https://app.geoly.ai/api/mcp', quiet: true } as Ctx;
    const loaded = await skills.loadSkillBundle(ctx);
    const r = await captureStderr(() => skills.installSkill(claude, loaded, home));
    check('1f offline loadSkillBundle → embedded copy', loaded.source === 'embedded');
    check('1f …which does not replace a newer installed skill', r.value.kept === true && /installed-99/.test(readSkill('.claude') ?? ''), r.err);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---- 2. background refresh without a new binary ----------------------------------------------
{
  function makeZip(files: Array<{ name: string; data: Buffer }>): Buffer {
    // Stored entries only; CRC left 0 (src/zip.ts does not verify it).
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
      const name = Buffer.from(f.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(f.data.length, 18);
      lh.writeUInt32LE(f.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt32LE(f.data.length, 20);
      cd.writeUInt32LE(f.data.length, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE(offset, 42);
      locals.push(lh, name, f.data);
      centrals.push(cd, name);
      offset += 30 + name.length + f.data.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  }

  const LIVE = '0.7.0';
  const zip = makeZip([
    { name: 'geoly-mcp/SKILL.md', data: skillMd(LIVE, 'from live zip') },
    { name: 'geoly-mcp/references/tools-catalog.md', data: Buffer.from('catalog 0.7.0') },
  ]);
  const zipSha = crypto.createHash('sha256').update(zip).digest('hex');

  type Mode = { release: 'current' | 'down'; skills: 'ok' | 'down' | 'hang' | 'badsha' };
  let mode: Mode = { release: 'current', skills: 'ok' };
  const calls: Array<{ url: string; bounded: boolean }> = [];
  const releaseUrl = resolveManifestUrl();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, bounded: init?.signal instanceof AbortSignal });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === releaseUrl) {
      if (mode.release === 'down') throw new TypeError('fetch failed (github unreachable)');
      // latest == this build: no new binary. The file URL is outside the download allowlist, so
      // even a bug that reached installRelease could not write anything.
      return json({ latest: VERSION, files: [{ os: 'windows', arch: 'x64', url: 'https://example.invalid/geoly', sha256: '00' }] });
    }
    if (url.endsWith('/skills/geoly-mcp.json')) {
      if (mode.skills === 'down') throw new TypeError('fetch failed (app.geoly.ai unreachable)');
      if (mode.skills === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }
      return json({ version: LIVE, zip: { sha256: mode.skills === 'badsha' ? 'f'.repeat(64) : zipSha, bytes: zip.length } });
    }
    if (url.endsWith('/skills/geoly-mcp.zip')) return new Response(zip, { status: 200 });
    throw new Error(`unexpected fetch in verification: ${url}`);
  }) as typeof fetch;

  const ctx = { endpoint: 'https://app.geoly.ai/api/mcp', quiet: true } as Ctx;
  const zipFetches = () => calls.filter((c) => c.url.endsWith('.zip')).length;

  try {
    // claude behind, codex present without the skill, cursor current (with a marker that must survive)
    resetHome();
    seedSkill('.claude', '0.6.1', 'old claude');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    seedSkill('.cursor', LIVE, 'cursor untouched');

    calls.length = 0;
    const r1 = await backgroundUpdate(ctx);
    check('2a no new binary → no binary swap reported', r1.binary === undefined, JSON.stringify(r1));
    check('2a stale host refreshed from the live zip', /from live zip/.test(readSkill('.claude') ?? '') && fs.existsSync(path.join(skillDir('.claude'), 'references', 'tools-catalog.md')));
    check('2a result names only that host', r1.skills.length === 1 && r1.skills[0]?.host === 'claude-code' && r1.skills[0]?.previous === '0.6.1' && r1.skills[0]?.version === LIVE, JSON.stringify(r1.skills));
    check('2a host without the skill is not installed into', !fs.existsSync(skillDir('.codex')));
    check('2a current host left alone', /cursor untouched/.test(readSkill('.cursor') ?? ''));
    check('2a every request carried a deadline', calls.length > 0 && calls.every((c) => c.bounded), JSON.stringify(calls));

    calls.length = 0;
    const r2 = await backgroundUpdate(ctx);
    check('2b everything current → nothing written, zip not downloaded', r2.skills.length === 0 && zipFetches() === 0, JSON.stringify(calls));

    seedSkill('.claude', '0.6.1', 'old claude');
    mode = { release: 'down', skills: 'ok' };
    const r3 = await backgroundUpdate(ctx);
    check('2c release channel down → skill still refreshed', r3.skills.length === 1 && /from live zip/.test(readSkill('.claude') ?? ''), JSON.stringify(r3));

    seedSkill('.claude', '0.6.1', 'old claude');
    mode = { release: 'current', skills: 'down' };
    const r4 = await captureStderr(() => backgroundUpdate(ctx));
    check('2d app.geoly.ai down → no throw, nothing written, silent', r4.value.skills.length === 0 && /old claude/.test(readSkill('.claude') ?? '') && r4.err === '', r4.err);

    mode = { release: 'current', skills: 'badsha' };
    const r5 = await backgroundUpdate(ctx);
    check('2e zip that does not match the manifest sha256 → not installed', r5.skills.length === 0 && /old claude/.test(readSkill('.claude') ?? ''));

    mode = { release: 'current', skills: 'hang' };
    const t0 = Date.now();
    const r6 = await backgroundUpdate(ctx);
    const ms = Date.now() - t0;
    check('2f a hanging skill manifest is cut at its 5 s timeout', r6.skills.length === 0 && ms >= 4_500 && ms < 10_000, `${ms}ms`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---- 3. resident tool names ------------------------------------------------------------------
{
  // geoly-app origin/refactor/tool-surface-consolidation src/lib/agent-api/tools.ts RESIDENT_NAMES
  const SERVER_RESIDENT = [
    'get_brand_context', 'get_current_date', 'get_topic_list',
    'get_prompt_list', 'get_prompt_detail', 'list_prompt_records', 'get_prompt_record_detail',
    'get_prompt_citations', 'get_url_detail', 'get_domain_detail',
    'get_brand_overview', 'query_analytics', 'get_citation_overview', 'get_brand_search_queries',
    'get_platform_matrix', 'get_verdict',
    'search_public_entities', 'resolve_my_brand_public',
  ];
  const expected = new Set([...SERVER_RESIDENT, 'list_organizations', 'list_brands']);
  const same = expected.size === CORE_TOOL_NAMES.size && [...expected].every((n) => CORE_TOOL_NAMES.has(n));
  check('3a CORE_TOOL_NAMES = server RESIDENT_NAMES + list_organizations/list_brands', same, [...CORE_TOOL_NAMES].join(','));
  const stale = [...CORE_TOOL_NAMES].filter((n) => n in REMOVED_TOOLS);
  check('3b no removed name is resident', stale.length === 0, stale.join(','));
}

// ---- 4. removed tool names ---------------------------------------------------------------------
{
  const BRAND = [
    'get_competitor_overview', 'get_brand_citations_daily', 'get_content_opportunities', 'get_ga4_page_data',
    'get_ga4_traffic_data', 'get_cf_traffic_data', 'list_citation_domains', 'get_page_detail',
    'get_url_reference_detail', 'get_competitor_polarity', 'get_risk_context_sources',
    'get_prompt_record_summaries', 'get_prompt_mention_rates', 'get_brand_mention_samples', 'get_audit_pages',
    'get_agent_ready_scan_detail',
  ];
  const PUBLIC = [
    'get_public_topic_overview', 'get_public_topic_brand_leaderboard', 'get_public_topic_som_trend',
    'get_public_topic_prompt_matrix', 'list_public_topic_prompts', 'get_public_topic_citation_domains',
    'get_public_topic_commerce', 'get_topic_competition_difficulty', 'compare_public_brands',
    'get_public_brand_perception', 'get_public_brand_perception_aspect_mentions', 'get_public_brand_rank_citation',
    'list_public_locales', 'get_available_platforms', 'get_public_data_window', 'list_public_shopping_boards',
    'get_public_search_query_detail', 'get_public_shopping_card_detail',
  ];
  const names = Object.keys(REMOVED_TOOLS);
  check('4a table covers the 16 brand-own + 18 public removed names, nothing else', names.length === 34 && [...BRAND, ...PUBLIC].every((n) => names.includes(n)));
  const chained = Object.entries(REMOVED_TOOLS).filter(([, e]) => e.tool in REMOVED_TOOLS);
  check('4a no replacement is itself a removed name', chained.length === 0, chained.map(([n]) => n).join(','));
  check('4a list_organizations is kept (not in the table)', !('list_organizations' in REMOVED_TOOLS));

  const surface = ['get_url_detail', 'get_verdict', 'query_analytics', 'get_brand_overview'];
  const e1 = unknownToolError('get_url_reference_detail', surface);
  check('4b removed name → usage_error / exit 2 naming the replacement', e1 instanceof GeolyError && e1.kind === 'usage_error' && e1.exitCode === 2 && /it is now get_url_detail/.test(e1.message), e1.message);
  check('4b hint carries the new call', (e1.hint ?? '').includes('geoly call get_url_detail --window_caliber rolling …'), e1.hint);
  const e2 = unknownToolError('get_brand_citations_daily', surface);
  check('4c not-drop-in alias → full recipe + the caveat', (e2.hint ?? '').includes(`--metrics '["citationCount"`) && (e2.hint ?? '').includes('sentiment.avgScore') && /not a drop-in replacement/.test(e2.hint ?? '') && !/same read model/.test(e2.hint ?? ''), e2.hint);
  const e2b = unknownToolError('get_cf_traffic_data', ['get_traffic_data']);
  check('4c drop-in with a caveat keeps "keep the other arguments" and adds the caveat', /keep the other arguments of the old call \(default window stays 7d\)/.test(e2b.hint ?? ''), e2b.hint);
  const e3 = unknownToolError('compare_public_brands', surface);
  check('4d replacement missing from this token → said so', /get_public_brand is not in this authorization's tool list either/.test(e3.hint ?? ''), e3.hint);
  const e4 = unknownToolError('get_brand_overveiw', surface);
  check('4e plain typo keeps the nearest-name suggestion', e4.message === 'Unknown tool "get_brand_overveiw"' && /Did you mean: get_brand_overview/.test(e4.hint ?? ''), `${e4.message} / ${e4.hint}`);

  // ---- 4f–4j: end to end through `geoly call` / `geoly schema` against a fake MCP endpoint ----
  let toolsList: Array<{ name: string; inputSchema?: unknown }> = [];
  let callReply: 'rpcError' | 'isError' = 'rpcError';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}') as { id: number; method: string; params?: { name?: string } };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (rpc.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: toolsList } }));
        return;
      }
      if (rpc.method === 'tools/call') {
        const text = `MCP error -32602: Tool ${rpc.params?.name} not found`;
        res.end(
          JSON.stringify(
            callReply === 'rpcError'
              ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: text } }
              : { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text }] } },
          ),
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
  const bin = path.join(process.cwd(), 'src', 'bin.ts');
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', bin, ...args, '--error-format', 'json'], {
        env: { ...process.env, GEOLY_MCP_ENDPOINT: endpoint, GEOLY_TOKEN: 'geom_verify', GEOLY_NO_AUTO_UPDATE: '1', GEOLY_NO_AUTO_AUTH: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  const errJson = (s: string) => {
    try {
      return JSON.parse(s.trim().split('\n').pop() ?? '') as { kind?: string; message?: string; hint?: string };
    } catch {
      return {};
    }
  };
  const obj = (props: string[]) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) });

  try {
    toolsList = [
      { name: 'get_url_detail', inputSchema: obj(['url', 'window_caliber']) },
      { name: 'get_verdict', inputSchema: obj(['view']) },
      { name: 'get_brand_overview', inputSchema: obj(['time_range']) },
    ];
    const r1 = await cli(['call', 'get_url_reference_detail', '--url', 'https://example.com/a', '--refresh']);
    const j1 = errJson(r1.stderr);
    check('4f geoly call <removed> → exit 2, replacement + new call on stderr, stdout empty', r1.status === 2 && r1.stdout === '' && j1.kind === 'usage_error' && /it is now get_url_detail/.test(j1.message ?? '') && (j1.hint ?? '').includes('geoly call get_url_detail --window_caliber rolling'), `status=${r1.status} ${r1.stderr.trim()}`);

    const r2 = await cli(['schema', 'get_competitor_polarity']);
    const j2 = errJson(r2.stderr);
    check('4g geoly schema <removed> → exit 2 with the replacement', r2.status === 2 && (j2.hint ?? '').includes('geoly call get_verdict --view competitors'), `status=${r2.status} ${r2.stderr.trim()}`);

    const r3 = await cli(['call', 'get_brand_overveiw', '--refresh']);
    const j3 = errJson(r3.stderr);
    check('4h plain typo through the CLI keeps the suggestion', r3.status === 2 && /Did you mean: get_brand_overview/.test(j3.hint ?? ''), r3.stderr.trim());

    // A tool list from before the deploy still has the old names; the server no longer does.
    toolsList = [
      { name: 'get_page_detail', inputSchema: obj(['url']) },
      { name: 'get_audit_pages', inputSchema: obj(['audit_id']) },
    ];
    callReply = 'rpcError';
    const r4 = await cli(['call', 'get_page_detail', '--url', 'https://example.com/a', '--refresh']);
    const j4 = errJson(r4.stderr);
    check('4i stale list + server "Tool … not found" (error frame) → replacement', r4.status === 2 && (j4.hint ?? '').includes('geoly call get_url_detail --window_caliber page') && !/tool list either/.test(j4.hint ?? ''), `status=${r4.status} ${r4.stderr.trim()}`);
    callReply = 'isError';
    const r5 = await cli(['call', 'get_audit_pages', '--audit_id', 'a1', '--refresh']);
    const j5 = errJson(r5.stderr);
    check('4j stale list + server "Tool … not found" (in-band isError) → replacement', r5.status === 2 && (j5.hint ?? '').includes('geoly call get_audit_detail --section pages'), `status=${r5.status} ${r5.stderr.trim()}`);
  } finally {
    server.close();
  }

  // ---- 4k–4p: the local agent (find_tools + direct calls), no network ----
  type ToolInfo = import('../src/mcp.js').ToolInfo;
  const catalog: ToolInfo[] = [
    { name: 'get_url_detail', description: 'One cited URL: citing prompts and platforms, rolling or page window.' },
    { name: 'get_verdict', description: 'Verdicts: which competitors AI prefers, and the risky source contexts.' },
    { name: 'get_public_brand', description: 'Public brand facets: overview, visibility, footprint, citations, shopping.' },
    { name: 'get_public_category', description: 'Category views: overview, brand leaderboard, share of brands over time.' },
    { name: 'get_public_topic', description: 'Topic views: overview, leaderboard, trend, prompts, commerce.' },
    { name: 'get_page_detail', description: 'legacy (stale list)' },
    { name: 'list_brands', description: 'Brands in the organization.' },
  ];
  let serverCalls = 0;
  let serverReply: 'notFound' | 'ok' = 'notFound';
  const stubClient = {
    callTool: async (name: string) => {
      serverCalls += 1;
      if (serverReply === 'notFound') throw new GeolyError('usage_error', `MCP error -32602: Tool ${name} not found`);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  };
  const makeSession = (active: string[], tools: ToolInfo[] = catalog) =>
    new (AgentSession as unknown as new (...args: unknown[]) => Record<string, unknown>)(
      { endpoint: 'https://app.geoly.ai/api/mcp', quiet: true } as Ctx,
      stubClient,
      { brand: { id: 'b1', name: 'Brand' }, system_prompt: '' },
      '',
      tools,
      new Set(active),
      [],
      'verify-session',
      new Workspace(home, async () => false),
    ) as unknown as {
      findTools(q: string): string;
      executeCall(c: { id: string; name: string; arguments: string }): Promise<{ text: string; failed: boolean }>;
      active: Set<string>;
      lastLoaded: string[];
    };

  const s1 = makeSession(['list_brands'], catalog.filter((t) => t.name !== 'get_page_detail'));
  const found = s1.findTools('get_url_reference_detail');
  check('4k find_tools(<removed name>) explains it with the new call', found.startsWith('Unknown tool "get_url_reference_detail"') && found.includes('get_url_detail(window_caliber="rolling", …)'), found);
  check('4k …and loads the replacement', s1.active.has('get_url_detail') && s1.lastLoaded.includes('get_url_detail') && /is now in your tool list/.test(found), found);

  const ranked = searchCatalog(
    catalog.map((t) => ({ name: t.name, description: t.description ?? '' })),
    'compare brands',
    new Set(['list_brands']),
  );
  check('4l find_tools("compare brands") ranks get_public_brand first (old-name words count)', ranked[0]?.name === 'get_public_brand', ranked.map((r) => r.name).join(','));
  const diff = searchCatalog(catalog.map((t) => ({ name: t.name, description: t.description ?? '' })), 'competition difficulty', new Set());
  check('4l find_tools("competition difficulty") ranks get_public_topic first', diff[0]?.name === 'get_public_topic', diff.map((r) => r.name).join(','));

  const s2 = makeSession(['list_brands'], catalog.filter((t) => t.name !== 'get_page_detail'));
  serverCalls = 0;
  const direct = await s2.executeCall({ id: 'c1', name: 'get_competitor_polarity', arguments: '{}' });
  check('4m direct call to a removed name → error with the replacement, no round trip', direct.failed && direct.text.includes('get_verdict(view="competitors", …)') && serverCalls === 0, direct.text);
  check('4m …and the replacement is loaded', s2.active.has('get_verdict'));

  const s3 = makeSession(['list_brands', 'get_page_detail']);
  serverCalls = 0;
  serverReply = 'notFound';
  const stale = await s3.executeCall({ id: 'c2', name: 'get_page_detail', arguments: '{}' });
  check('4n stale list: server "not found" for a removed name → replacement, no false "not in your list"', stale.failed && stale.text.includes('get_url_detail(window_caliber="page", …)') && !/tool list either/.test(stale.text) && serverCalls === 1, stale.text);

  serverCalls = 0;
  const other = await s3.executeCall({ id: 'c3', name: 'get_something_else', arguments: '{}' });
  check('4o a name that is not in the table goes to the server as before', other.failed && serverCalls === 1 && other.text.includes('Tool get_something_else not found'), other.text);

  serverReply = 'ok';
  serverCalls = 0;
  const before = await s3.executeCall({ id: 'c4', name: 'get_page_detail', arguments: '{}' });
  check('4p before the deploy (server still has the old name) the call just works', !before.failed && serverCalls === 1, before.text);
}

clearTimeout(watchdog);
fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
