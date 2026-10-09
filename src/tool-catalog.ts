/**
 * 工具面的渐进披露。
 *
 * 服务端的 MCP 工具面有四五十个，全量塞进每一步是上万 tokens——而且不只是贵：一次只
 * 与两三个工具相关的问题，摆几十个选项本身就是干扰（Anthropic《context engineering》
 * 明确反对「全塞前面」，他们自己用延迟加载解决）。
 *
 * 做法：常驻一小组 + `find_tools` 按需把其余的取进来。
 *
 * 常驻集**由真实用量决定，不是我们猜的**。2026-09-29 工具面精简（geoly-app #1985，技能
 * 0.7.0）同批按真实用量换血：mcp_call_log 近 90 天**全部调用方**（CLI、MCP 客户端、托管
 * agent 一起算，不再只按托管 agent 的 run 排），真实工作就是「列表 ↔ 详情乒乓下钻」那一串，
 * 外加品牌级总览。被合并删掉的旧名一个都不能留在这里：
 * 常驻的必须是活着的名字（旧名 → 新入口见 removed-tools.ts）。
 *
 * 🔴 与服务端 `src/lib/agent-api/tools.ts` 的 `RESIDENT_NAMES` 是同一份名单，改要一起改。
 * 唯一差别是 ENTRY_POINTS 里的 list_organizations / list_brands：本地 agent 走 MCP，多组织 /
 * 多品牌 token 要靠它们选组织和品牌；Agent API 面没有这两个（组织品牌在鉴权时已定死）。
 */
import { LEGACY_NAMES_BY_TOOL } from './removed-tools.js';

/** 下钻主链与品牌级总览（括号内为近 90 天全部调用方的调用次数，按旧名合并后计）。 */
const HIGH_TRAFFIC = [
  // 下钻主链
  'get_prompt_list', // 37k
  'get_prompt_detail', // 2.6k
  'list_prompt_records', // 20k（+ 已并入的每平台最新一条 6.4k，原 get_prompt_record_summaries）
  'get_prompt_record_detail', // 116k
  'get_prompt_citations', // 51k
  'get_url_detail', // 11.5k（原 get_url_reference_detail）
  'get_domain_detail', // 2.7k
  // 品牌级总览
  'get_brand_overview', // 1.6k
  'query_analytics', // 5.4k
  'get_citation_overview', // 1.2k
  'get_brand_search_queries', // 1.3k
  'get_platform_matrix', // 竞品矩阵（原 get_competitor_overview 并入）
  'get_verdict', // 竞品倾向 / 风险信源（原 get_competitor_polarity / get_risk_context_sources）
];

/** 入口与定位：占比不高，但少了它们连第一步都迈不出去。 */
const ENTRY_POINTS = [
  // get_brand_context：一次定位（品牌/日期/平台/topics/竞品/额度），替代 run 开头的
  // get_current_date + get_competitor_list + 平台列表那几跳
  'get_brand_context',
  'get_current_date',
  'get_topic_list', // topic id 的来源
  // public 桥
  'search_public_entities',
  'resolve_my_brand_public',
  // 仅 MCP 面（本地 agent）：多组织 / 多品牌 token 的选择器。list_organizations 也是已发布
  // CLI 选组织的硬依赖（org-select.ts），服务端精简时特意保留。
  'list_organizations',
  'list_brands',
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
 * 不引入向量或模糊匹配库——工具只有几十个，描述又长又具体，词命中已经足够；
 * 这里的目标是「让模型够得着」，不是做搜索质量。
 *
 * 旧名也算名称：2026-09-29 的合并把 compare / difficulty / perception / locales 这类强信号词
 * 从工具名上拿掉了（compare_public_brands → get_public_brand 的 brand_ids），而模型照旧用这些
 * 词、甚至直接拿旧名来搜。每个工具吸收的旧名（removed-tools.ts）按名称权重参与打分，与服务端
 * Agent API 的 find_tools 同一做法；整条旧名原样命中时给最高分，让新入口排第一。
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
      const legacy = LEGACY_NAMES_BY_TOOL[t.name] ?? [];
      let score = 0;
      for (const term of terms) {
        // 名称命中比描述命中更能说明意图，权重更高
        if (legacy.includes(term)) score += 10;
        else if (name.includes(term) || legacy.some((old) => old.includes(term))) score += 3;
        if (description.includes(term)) score += 1;
      }
      return { entry: t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_MATCHES).map((s) => s.entry);
}

/** 已额外装载的工具是否还有余额——防止一路把整个工具面搜回来，白做这套。 */
export function canLoadMore(loadedCount: number): boolean {
  return loadedCount < MAX_LOADED;
}

export const TOOL_LOAD_LIMIT = MAX_LOADED;
