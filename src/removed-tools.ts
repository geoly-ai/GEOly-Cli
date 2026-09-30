/**
 * Tool names the server removed, and where each one went.
 *
 * On 2026-09-29 the GEOly tool surface was consolidated (geoly-app #1985, skill 0.7.0): related
 * tools became views / modes / parameters of one tool, and the old names were **deleted — no
 * forwarding aliases**. A script or an agent still using an old name now gets a bare "unknown
 * tool" from the server, which says nothing about the fix. This table turns that into "it is
 * `get_url_detail` now — `geoly call get_url_detail --window_caliber rolling …`".
 *
 * Source: geoly-app `skills/geoly-mcp/references/tools-catalog.md` § Removed brand-own tools and
 * § Removed public tools (same data as the server's `REMOVED_TOOL_REPLACEMENTS` /
 * `PUBLIC_REMOVED_TOOL_NAMES`). Every entry selects the old behaviour with the **same read model,
 * arguments, price and timeout** unless its `note` says otherwise — the three deprecated aliases
 * dropped in the same release (get_competitor_overview, get_brand_citations_daily,
 * get_content_opportunities) are the exceptions and say so.
 *
 * Only consulted when the server does not list the name: before the consolidation is deployed
 * the old names still resolve normally and this table stays silent.
 */

/** A placeholder argument the caller has to fill in (rendered as-is, e.g. `<path>`). */
interface Placeholder {
  placeholder: string;
}

type ArgValue = string | number | boolean | string[] | Placeholder;

export interface RemovedTool {
  /** The tool that absorbed it. */
  tool: string;
  /** Arguments that select the old behaviour on `tool`; the old call's other arguments carry over. */
  args: Record<string, ArgValue>;
  /** A caveat worth knowing (a default, a renamed parameter, a price), when there is one. */
  note?: string;
  /**
   * The three deprecated aliases removed in the same release: their replacement is a different
   * shape, price or question, so the hint must not say "same arguments, same numbers".
   */
  notDropIn?: true;
}

const ph = (placeholder: string): Placeholder => ({ placeholder });

/** The full per-day recipe that reproduces the removed get_brand_citations_daily rows. */
const DAILY_METRICS = [
  'citationCount',
  'mentionCount',
  'mentionedRecords',
  'completedRecords',
  'brandCitationRecords',
  'aigvr',
  'mentionRate',
  'citationRate',
  'sentiment.positive',
  'sentiment.neutral',
  'sentiment.negative',
  'sentiment.mixed',
  'sentiment.unknown',
  'sentiment.scoredRecords',
  'sentiment.avgScore',
];

export const REMOVED_TOOLS: Readonly<Record<string, RemovedTool>> = {
  // ---- Brand-own (16) ------------------------------------------------------------------------
  get_competitor_overview: {
    tool: 'get_platform_matrix',
    args: { dimension: 'competitor', competitor_limit: 20, include_totals: true },
    notDropIn: true,
    note:
      'same competitor set and numbers, different shape: your brand = the first row (isBrand) and its totals, competitors = the other rows (totals + per-platform cells); ranked by metric, not by mentions; priced deep 10 credits (was standard 3)',
  },
  get_brand_citations_daily: {
    tool: 'query_analytics',
    args: {
      dataset: 'brand_citations_daily',
      start_date: ph('<YYYY-MM-DD>'),
      end_date: ph('<YYYY-MM-DD>'),
      dimensions: ['date', 'platform', 'platformName'],
      metrics: DAILY_METRICS,
      limit: 1000,
    },
    notDropIn: true,
    note:
      'pass this full recipe (the dataset alone returns only 6 default metrics); rows[] with flat sentiment.* columns; more than 1000 date x platform rows (about 166 days on all platforms) must be split into shorter windows',
  },
  get_content_opportunities: {
    tool: 'get_citation_overview',
    args: { section: 'table', gap_only: true },
    notDropIn: true,
    note:
      'answers a different question: domains where a tracked competitor is mentioned and you are not. For the prompts one domain misses, read get_domain_detail (prompts[]) instead',
  },
  get_ga4_page_data: { tool: 'get_traffic_data', args: { source: 'ga4', page_path: ph('<path>') } },
  get_ga4_traffic_data: { tool: 'get_traffic_data', args: { source: 'ga4' } },
  get_cf_traffic_data: { tool: 'get_traffic_data', args: { source: 'cloudflare' }, note: 'default window stays 7d' },
  list_citation_domains: { tool: 'get_citation_overview', args: { section: 'table' } },
  get_page_detail: { tool: 'get_url_detail', args: { window_caliber: 'page' } },
  get_url_reference_detail: { tool: 'get_url_detail', args: { window_caliber: 'rolling' } },
  get_competitor_polarity: { tool: 'get_verdict', args: { view: 'competitors' } },
  get_risk_context_sources: {
    tool: 'get_verdict',
    args: { view: 'sources' },
    note: 'default window stays 7d (time_range 30d matches the page)',
  },
  get_prompt_record_summaries: {
    tool: 'list_prompt_records',
    args: { latest_per_platform: true },
    note: 'same bare array',
  },
  get_prompt_mention_rates: {
    tool: 'get_prompt_list',
    args: { view: 'mention_rates' },
    note: 'sort_order defaults to asc in this view',
  },
  get_brand_mention_samples: { tool: 'list_brand_answers', args: { view: 'mention_samples' } },
  get_audit_pages: { tool: 'get_audit_detail', args: { section: 'pages' } },
  get_agent_ready_scan_detail: { tool: 'get_agent_ready_scans', args: { scan_id: ph('<scan_id>') } },

  // ---- Public / industry (18) ----------------------------------------------------------------
  get_public_topic_overview: { tool: 'get_public_topic', args: { view: 'overview' } },
  get_public_topic_brand_leaderboard: { tool: 'get_public_topic', args: { view: 'brand_leaderboard' } },
  get_public_topic_som_trend: { tool: 'get_public_topic', args: { view: 'som_trend' } },
  get_public_topic_prompt_matrix: { tool: 'get_public_topic', args: { view: 'prompt_matrix' } },
  list_public_topic_prompts: { tool: 'get_public_topic', args: { view: 'prompts' } },
  get_public_topic_citation_domains: { tool: 'get_public_topic', args: { view: 'citation_domains' } },
  get_public_topic_commerce: { tool: 'get_public_topic', args: { view: 'commerce' } },
  get_topic_competition_difficulty: {
    tool: 'get_public_topic',
    args: { view: 'difficulty' },
    note: 'topic_id | prompt_id | product_space_id as before, same id-dependent price',
  },
  compare_public_brands: {
    tool: 'get_public_brand',
    args: { brand_ids: ph('<2-4 public brand ids>') },
    note: 'plus the facet view: omitted view = visibility, the old compare default; charged per brand as before',
  },
  get_public_brand_perception: {
    tool: 'get_public_brand',
    args: { view: 'perception' },
    note: 'mode "aspect_mentions" is now view "perception_mentions" (aspect required)',
  },
  get_public_brand_perception_aspect_mentions: {
    tool: 'get_public_brand',
    args: { view: 'perception_mentions', aspect: ph('<normalized_label>') },
    note: 'aspect = the old normalized_label',
  },
  get_public_brand_rank_citation: {
    tool: 'get_public_brand',
    args: { view: 'rank_citation' },
    note: 'mode "rows" is now view "rank_citation_rows"',
  },
  list_public_locales: { tool: 'get_public_coverage', args: { view: 'locales' }, note: 'free' },
  get_available_platforms: {
    tool: 'get_public_coverage',
    args: { view: 'platforms' },
    note: "free; same scope values (your own brand's platforms are also in get_brand_context)",
  },
  get_public_data_window: { tool: 'get_public_coverage', args: { view: 'data_window' }, note: 'free' },
  list_public_shopping_boards: {
    tool: 'list_public_shopping_products',
    args: { view: 'boards' },
    note: 'page stays 0-based for boards (products pages start at 1)',
  },
  get_public_search_query_detail: {
    tool: 'get_public_search_queries',
    args: { mode: 'query_detail' },
    note: 'mode "theme_detail" for a theme',
  },
  get_public_shopping_card_detail: {
    tool: 'get_public_shopping_product_detail',
    args: { mode: 'card', product_space_id: ph('<product_space_id>') },
    note: 'days 1-180 (over 90 costs 2x)',
  },
};

/** When the consolidation happened — quoted in every message so a reader can date the change. */
const REMOVED_ON = '2026-09-29';

/** `--name value` for the CLI: JSON arrays in single quotes, placeholders verbatim. */
function cliArg(name: string, value: ArgValue): string {
  if (typeof value === 'object' && !Array.isArray(value)) return `--${name} ${value.placeholder}`;
  if (Array.isArray(value)) return `--${name} '${JSON.stringify(value)}'`;
  return `--${name} ${String(value)}`;
}

/** `name=value` for a function call as an agent writes it. */
function fnArg(name: string, value: ArgValue): string {
  if (typeof value === 'object' && !Array.isArray(value)) return `${name}=${value.placeholder}`;
  return `${name}=${JSON.stringify(value)}`;
}

/** The replacement call: `geoly call get_url_detail --window_caliber rolling …` or `get_url_detail(window_caliber="rolling", …)`. */
export function replacementCall(entry: RemovedTool, style: 'cli' | 'fn'): string {
  const args = Object.entries(entry.args);
  if (style === 'cli') return ['geoly call', entry.tool, ...args.map(([k, v]) => cliArg(k, v)), '…'].join(' ');
  return `${entry.tool}(${[...args.map(([k, v]) => fnArg(k, v)), '…'].join(', ')})`;
}

/**
 * The one-paragraph explanation for a removed name, or undefined when `name` is not one.
 * `available` = the tool names this token actually has, to flag a replacement it does not have
 * either (e.g. public tools below the Grow plan).
 */
export function removedToolAdvice(
  name: string,
  style: 'cli' | 'fn',
  available?: ReadonlySet<string>,
): { message: string; hint: string; replacement: string } | undefined {
  const entry = Object.prototype.hasOwnProperty.call(REMOVED_TOOLS, name) ? REMOVED_TOOLS[name] : undefined;
  if (!entry) return undefined;
  const message = `Unknown tool "${name}": removed on ${REMOVED_ON} in the GEOly tool-surface consolidation (no alias) — it is now ${entry.tool}`;
  const missing =
    available && !available.has(entry.tool)
      ? ` Note: ${entry.tool} is not in this authorization's tool list either${style === 'cli' ? ' (see `geoly tools`)' : ''}.`
      : '';
  const hint =
    `Call ${replacementCall(entry, style)} — ` +
    (entry.notDropIn
      ? `not a drop-in replacement: ${entry.note}.`
      : `same read model, arguments and price; keep the other arguments of the old call${entry.note ? ` (${entry.note})` : ''}.`) +
    missing;
  return { message, hint, replacement: entry.tool };
}

/**
 * Whether a server error is "no such tool". Needed for the minute after a deploy: the CLI's
 * tools/list cache (60 s) can still list a removed name, so the call goes out and the server
 * answers `MCP error -32602: Tool <name> not found` instead of the CLI's table answering first.
 */
export function isToolNotFoundError(text: string): boolean {
  return /\bTool\s+\S+\s+not found\b/i.test(text);
}

/** Replacement tool → the removed names it absorbed (find_tools scores these like its own name). */
export const LEGACY_NAMES_BY_TOOL: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [old, entry] of Object.entries(REMOVED_TOOLS)) (out[entry.tool] ??= []).push(old);
  return out;
})();
