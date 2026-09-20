/**
 * Render one scripted turn through the real chat renderer, no network, no credits
 * (`node --import tsx scripts/preview-chat.mts`). For eyeballing the terminal UI after a change:
 * banner → tool call/result lines → markdown-lite answer → turn footer → /status → exit line.
 *
 * Feeds `AgentSession.run` with a fake event stream by stubbing the session object; everything
 * downstream (spinner, markdown, tool lines, stats) is the production code path.
 */
import { ChatCommand } from '../src/commands/chat.js';
import type { LoopEvent } from '../src/loop.js';

const events: LoopEvent[] = [
  { type: 'step', n: 1 },
  { type: 'tool', phase: 'call', name: 'get_brand_overview', args: 'time_range: "30d", platform: "chatgpt"' },
  { type: 'tool', phase: 'result', name: 'get_brand_overview', ms: 1840, bytes: 3412 },
  { type: 'step', n: 2 },
  { type: 'tool', phase: 'call', name: 'get_prompt_citations', args: 'limit: 20, platform: "chatgpt"' },
  { type: 'tool', phase: 'error', name: 'get_prompt_citations', ms: 60210, message: 'TOOL_TIMEOUT: get_prompt_citations timed out' },
  { type: 'step', n: 3 },
  { type: 'text', text: '## Visibility this month\n\nYour **AIGVR on ChatGPT** is `34.8%`, down ' },
  { type: 'text', text: '6.3 pts from last month.\n\n- Mention rate: **41%**\n- Citation rate: 12%\n\n1. Fix the pricing page\n2. Add an FAQ block\n\n```sql\nselect 1;\n```\n> Numbers are record-weighted.\n' },
  { type: 'done', steps: 3, turnTokens: 12_340, stopped: 'model' },
];

async function* fakeRun(): AsyncGenerator<LoopEvent> {
  for (const ev of events) {
    await new Promise((r) => setTimeout(r, ev.type === 'tool' && ev.phase === 'call' ? 400 : 60));
    yield ev;
  }
}

const session = {
  id: 'sess_preview',
  profile: { brand: { id: 'br_123', name: 'Anker SOLIX US' }, model: 'openai/gpt-5.6-luna' },
  toolCount: 19,
  catalogSize: 72,
  memoryCount: 2,
  workspace: { root: process.cwd() },
  run: () => fakeRun(),
  reset: () => undefined,
};

const cmd = new ChatCommand();
const priv = cmd as unknown as {
  banner: (s: unknown) => void;
  runTurn: (ctx: unknown, s: unknown, q: string) => Promise<{ steps: number; tokens: number }>;
  status: (s: unknown, stats: unknown) => void;
};
const ctx = { quiet: false, output: 'json', errorFormat: 'human' };

priv.banner(session);
process.stderr.write(`│ ❯ how did our visibility move this month?\n`);
const turn = await priv.runTurn(ctx, session, 'q');
priv.status(session, { turns: 1, steps: turn.steps, tokens: turn.tokens, startedAt: Date.now() - 9_400 });
