/**
 * 工具面的渐进披露。
 *
 * 服务端的 MCP 工具面有 70+ 个，全量塞进每一步约 2 万 tokens——而且不只是贵：一次只
 * 与两三个工具相关的问题，摆 70 个选项本身就是干扰（Anthropic《context engineering》
 * 明确反对「全塞前面」，他们自己用延迟加载解决）。
 *
 * 做法：常驻一小组 + `find_tools` 按需把其余的取进来。
 *
 * 常驻集**由真实用量决定，不是我们猜的**——但要看对的用量：第一版按 mcp_call_log
 * （2026-07~08）定，那是 MCP 客户端（Plaud 式列表↔详情乒乓）的形态；agent 自己回答问题
 * 时用的是另一批工具。2026-09-20 改按托管 agent 30 天 run 的 tools_used 重排
 * （geoly-app docs/mcp/TOOL_PERF_AND_SURFACE_ASSESSMENT_2026-09.md §3.2）：旧名单里六个
 * public 下钻工具 agent 一个月用了 ≤1 次，而引用/竞品/平台矩阵每次都要先 find_tools——
 * 引用域名题在 find_tools 之后两次超时、烧 94 credits 失败就是它的账。
 *
 * 🔴 与服务端 `src/lib/agent-api/tools.ts` 的 `RESIDENT_NAMES` 是同一份名单，改要一起改。
 */

/** 托管 agent 30 天 run 里真正高频的下钻与分析工具（括号内为 run 数）。 */
const HIGH_TRAFFIC = [
  'get_brand_overview', // 174
  'query_analytics', // 85
  'get_prompt_list', // 81
  'get_citation_overview', // 67
  'get_competitor_overview', // 51
  'get_brand_citations_daily', // 24
  'get_prompt_detail', // 23
  'get_competitor_polarity', // 23
  'get_platform_matrix', // 19
  'get_prompt_citations', // 16
  'get_brand_search_queries', // 13
  'get_prompt_record_summaries', // 12
  'get_prompt_record_detail', // 12
];

/** 入口与发现：占比不高，但少了它们连第一步都迈不出去。 */
const ENTRY_POINTS = [
  'get_topic_list', // topic id 的来源（服务端 2026-09-20 起才在面上）
  'get_current_date',
  'search_public_entities',
  'list_organizations',
  'list_brands',
  'resolve_my_brand_public',
];

export const CORE_TOOL_NAMES = new Set([...HIGH_TRAFFIC, ...ENTRY_POINTS]);

/** 一次搜索最多带回多少个，以及一个会话最多额外装载多少个。 */
const MAX_MATCHES = 8;
const MAX_LOADED = 24;

export const FIND_TOOLS_TOOL = {
  type: 'function' as const,
  name: 'find_tools',
  description:
    'Look up GEOly tools that are not currently in your tool list and make them available. ' +
    'The list you start with covers the common paths; everything else — audits, shopping and ' +
    'shelf data, ads, source scorecards, competitor and sentiment breakdowns, locale and ' +
    'category browsing — is here. Search by what you want to find out, not by tool name ' +
    '("which retailers stock us", "site audit issues"). Matches become callable immediately.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you are trying to find out, in a few words.',
      },
    },
    required: ['query'],
  },
};

export interface CatalogEntry {
  name: string;
  description: string;
}

/**
 * 极简检索：按查询词在名称与描述里的命中数排序。
 *
 * 不引入向量或模糊匹配库——工具只有 70 来个，描述又长又具体，词命中已经足够；
 * 这里的目标是「让模型够得着」，不是做搜索质量。
 */
export function searchCatalog(
  catalog: CatalogEntry[],
  query: string,
  excluded: Set<string>
): CatalogEntry[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const scored = catalog
    .filter((t) => !excluded.has(t.name))
    .map((t) => {
      const name = t.name.toLowerCase();
      const description = t.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        // 名称命中比描述命中更能说明意图，权重更高
        if (name.includes(term)) score += 3;
        if (description.includes(term)) score += 1;
      }
      return { entry: t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_MATCHES).map((s) => s.entry);
}

/** 已额外装载的工具是否还有余额——防止一路搜回 70 个，白做这套。 */
export function canLoadMore(loadedCount: number): boolean {
  return loadedCount < MAX_LOADED;
}

export const TOOL_LOAD_LIMIT = MAX_LOADED;
