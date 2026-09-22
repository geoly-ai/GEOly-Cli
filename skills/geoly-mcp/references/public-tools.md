# GEOly MCP — public / industry intelligence tools (29)

_Use this when doing cross-brand work (leaderboards, whitespace, momentum, AI-search demand, perception, shopping) or anything involving the locale convention._

The **cross-brand** surface: AI brand visibility at the category/topic level, not just the
customer's own monitoring. This is the competitive-intelligence layer — leaderboards,
whitespace, momentum, AI-search demand, perception, shopping.

## Access & gating

- **Plan**: Grow tier and above — plan IDs `grow | advanced | plus | enterprise` (the gate
  `canAccessMcp`; "Grow" is $149/mo, the old "Growth+" label). **Multi-org connections get
  public tools too**, as long as any accessible org qualifies (writes stay clamped read-only).
  If a public tool is missing, no accessible org has the tier or an active entitlement.
- Public tools read the **`public_*` canonical model** — a *separate collection pipeline*
  from the brand's own monitoring. The same brand's numbers can differ between the self
  surface and the public surface; never reconcile one against the other.

## Locale convention (read this first)

Most public responses are wrapped as:

```jsonc
{ "localeUsed": {"country":"US","language":"en"},
  "defaulted": true,          // true = your requested locale fell back to US/en
  "data": { ... },
  "availableLocales": [ ... ] // present on resolve/list calls
}
```

- `country` / `language` params are usually **optional** and default to `US` / `en` — except
  `compare_public_brands`, where `country` **and** `language` are **required** (comparisons
  must share one locale to be valid).
- If `defaulted=true`, tell the user the data is the fallback locale, then offer to re-run with
  a locale from `availableLocales`.

## Platform convention (read this too)

Public facts are sliced by AI **platform** (`chatgpt`, `google_ai`, …). Almost every
data-returning public tool takes an **optional `platform`** param that **defaults to
`chatgpt`** — so if you omit it you see ChatGPT-only numbers, which under-reports total AI
visibility once other platforms have data.

- **Discover first**: call `get_available_platforms` for the scope you're about to query
  (brand / topic / category / global). It returns platforms ordered by data volume. If only
  `[chatgpt]` comes back, that scope has no other-platform data yet — **omit `platform`**.
- Only pass a non-`chatgpt` `platform` (e.g. `google_ai`) when `get_available_platforms`
  actually lists it; passing a platform with no data yields an empty result (no graceful
  fallback on the MCP path).
- **Exceptions** (no `platform` param): `search_public_entities` and `list_public_locales`
  (platform-agnostic discovery), `get_topic_competition_difficulty` (difficulty is a
  cross-platform concentration metric), `get_public_topic_record_detail` (a single record
  already belongs to exactly one platform). `get_public_topic_brand_leaderboard` also accepts
  a legacy `platform_id` alias — prefer `platform`.

## Time window convention (since 2026-09 — read this before quoting any number)

Public collection is a **weekly batch**, not daily. Every GEOly public page (`/brand/[id]`,
`/category/[slug]`, `/topic/[slug]`, explore) windows its figures as **"the latest PUBLISHED
complete batch day, back 30 / 60 / 90 days"** — never `max(record_date)` (a partial
re-collection would push the anchor) and never today (the window would slide daily).

- **Default changed on 2026-09**: the windowed public tools now default to that **30d batch
  window** (was: all history). Affected: `get_public_brand` (visibility+trend / footprint /
  competitors / citations / category_ranking / citation_totals — `overview` stays all-history
  like the page hero unless you pass `range`),
  `compare_public_brands`, `get_public_category` (overview / brand_leaderboard / som_trend /
  topics / citation_domains), `get_public_topic_brand_leaderboard`, `get_public_topic_som_trend`,
  `get_public_topic_prompt_matrix`, `list_public_topic_prompts`,
  `get_public_topic_citation_domains`; `get_public_source_domain_detail.topUrls` follows the
  page's `period` (30d default). Old all-history numbers **will not reconcile** with fresh pulls.
- **Controls** (same on every windowed tool): `range: 30d | 60d | 90d | all` (`all` = the
  pre-2026-09 all-history caliber; `90d` needs Advanced+, otherwise clamped to 60d) or an
  explicit `date_from` + `date_to` (both required; overrides `range`).
- **Echo**: every windowed response carries `window` = `{ source: batch|explicit|all, range,
  from, to, days, batchDates, latestPublishedBatch, applied, crossesBreakpoint, note }`. Quote
  `from`/`to` as the "as of" range; `applied=false` means that facet never windows (revenue is a
  modeled monthly stock; shopping is a rolling N days from today; recent_mentions is "latest").
  `crossesBreakpoint=true` = the window spans a collection-scale change — no period-over-period
  claims inside it.
- **Get the anchor first**: `get_public_data_window` (free) returns `latestPublishedBatch`,
  the published batch days and the resolved 30/60/90d windows per platform (plus a locale's
  batch days or a category's available locales/platforms) — call it at the start of any
  cross-brand task so all numbers share one "as of" date and reconcile with the web pages.
- **Intentional exceptions**: `get_public_brand_perception` stays **all-history by default**
  (perception signal accrues slowly; a 30-day sample usually fails the aspect threshold) — pass
  `range=30d` explicitly for the page caliber. `get_public_topic_commerce`,
  `get_public_topic_prompt_detail`, `get_topic_competition_difficulty` and the AIO
  `get_public_brand_rank_citation` keep their own calibers (documented per tool).

## IDs: how to get them

Start from a name/domain, not an ID. `search_public_entities` resolves free text → brand /
category / topic IDs and slugs. Then use the typed tool. `list_public_topics`,
`list_public_locales` and `get_available_platforms` help enumerate; `get_public_data_window`
gives the time anchor.

---

## 1. Resolve & browse (5)

| Tool | Purpose | Key params |
|---|---|---|
| `get_public_data_window` | **Free. Time anchor** every public page uses: `latestPublishedBatch`, `observedFrom`, published batch days, and the resolved `30d` / `60d` / `90d` windows (`from`, `to`, `batchDates`, `crossesBreakpoint`) for one platform; optional locale batch days / category availability. Call first for any windowed read | `platform (default chatgpt), country, language, product_space_id` |
| `search_public_entities` | Free-text resolver: brand / category / topic / product name or domain → public IDs + slugs. Returns categories, topics, brands **and citation source domains**; set `include_products=true` to also search shopping products (needs ≥3 query chars — shorter returns an empty group + `productsNote`; each hit carries `productId` → `get_public_shopping_product_detail`, `stale`/`latestSeen` freshness flags, and `productSpaceId` when you also pass `country`+`language`) | `query (2–120 chars), limit (1–20, default 6), include_products (bool), country, language` |
| `list_public_topics` | Browse/paginate public topics, optional status/search filter | `page, page_size (1–100), country, language, status: draft\|active\|rejected\|archived, search, platform` |
| `list_public_locales` | List valid `{country, language}` pairs for an entity | `entity_kind: content\|brand\|topic_slug\|product_space, entity_id` |
| `get_available_platforms` | **Discovery**: which AI platforms have data for a scope (call before passing `platform`). topic / category / global: ordered by volume with `recordCount`, `[0]` = default. **`scope=brand` (2026-09-20)**: same existence probe as the public brand page — identical set, but `recordCount` is `null` and order is display priority (chatgpt, google_ai, google_ai_overview, …) | `scope: brand\|topic\|category\|global (default global), brand_id, topic_id, product_space_id, country, language` |

---

## 2. Topic tools (10)

| Tool | Purpose | Key params |
|---|---|---|
| `get_public_topic_overview` | Overview of one public topic | `topic_id \| slug, country, language` |
| `get_public_topic_brand_leaderboard` | Brand leaderboard ranked by Share of Mention (absolute 1-based rank). Windowed (30d batch default) | `topic_id, platform (legacy alias: platform_id), range (30d\|60d\|90d\|all), date_from, date_to, page, page_size (1–100)` |
| `get_public_topic_som_trend` | SoM trend, one point per collection batch (tracks #1 leader by default, or a specific `brand_known_id`). Windowed; `max_points` defaults to the window length | `topic_id, brand_known_id, range, date_from, date_to, max_points (2–90)` |
| `get_public_topic_prompt_matrix` | Prompt × brand heatmap (per-prompt SoM %). **Rows are limited to prompts covering the top-N brands** — a prompt whose only mentions fall outside those columns is omitted, so this can return fewer rows than the topic has prompts. Raise `top_brands` or use `list_public_topic_prompts` for the full list. Windowed (30d batch default; was all-history with no date params) | `topic_id, top_brands (1–20), max_prompts (1–200), range, date_from, date_to` |
| `list_public_topic_prompts` | **Enumerate EVERY prompt** under a topic (not brand-filtered, unlike the matrix), sorted by total mentions. Each item: text + intent + total mentions + leader brand & share. Use to get the complete prompt list or a `prompt_id` for `get_public_topic_prompt_detail`. Windowed (30d batch default) | `topic_id, platform, range, date_from, date_to` |
| `get_public_topic_prompt_detail` | One prompt: metadata, per-brand breakdown, recent records w/ snippets, top citation domains | `prompt_id, record_limit (1–50), citation_limit (1–50)` |
| `get_public_topic_record_detail` | One public record (AI answer): metadata, snippeted answer (~8k), capped citations/sources/shopping, brands mentioned | `record_id` |
| `get_public_topic_citation_domains` | Citation-domain leaderboard for the topic (most-cited usable domains + rates). Windowed (30d batch default; was all-history with no date params) | `topic_id, limit (1–200), range, date_from, date_to` |
| `get_public_topic_commerce` | Commerce aggregate: activation rate, price stats, retail channels, price bands, products | `topic_id` |
| `get_topic_competition_difficulty` | AI-visibility **difficulty 0–100** (like SEO keyword difficulty) — percentile of CR3 within category | `topic_id \| prompt_id \| product_space_id, country (default US), language (default en)` |

---

## 3. Brand tools (4 + 1 deprecated alias)

| Tool | Purpose | Key params |
|---|---|---|
| `get_public_brand` | One public brand across topics, **faceted**. Windowed (30d batch default) on visibility+trend / footprint / competitors / citations / category_ranking / citation_totals; overview = all-history like the page hero (pass `range` to window it); shopping = rolling N days from today; revenue never windows | `brand_id, view, country, language, limit (1–200), include_trend (bool), days (2–90, legacy), range (30d\|60d\|90d\|all), date_from, date_to` |
| `get_public_brand_rank_citation` | **AIO-only** Rankings × AI Citations: coverage + four quadrants (searches) + displacers (`mode=board`), or per-search detail with per-round stability (`mode=rows`, `snapshot_key` pins consistency) | `brand_id, mode (board/rows), quadrant, page, page_size (1–20), snapshot_key, country, language` |
| `get_public_brand_perception` | AI perception profile, **two modes**: `profile` (default) = canonical aspects + polarity + evidence + `hasEnoughSignal` — **all-history by default (intentional)**, `range=30d` gives the page caliber; `aspect_mentions` = drill-down, the source mentions behind one aspect (`aspect` = its `normalized_label` from a profile call), always all-time | `brand_id, mode (profile\|aspect_mentions), aspect (aspect_mentions mode), country, language, limit (profile 1–100 / aspect_mentions 1–200, default 50), min_mentions_per_aspect, range (profile only: all default \| 30d \| 60d \| 90d)` |
| `compare_public_brands` | Side-by-side of **2–4** brands on one facet, **shared locale required**, all brands on the SAME window (30d batch default) | `brand_ids[] (2–4), view, country (required), language (required), limit (1–200), include_trend (bool), days (2–90, legacy), range, date_from, date_to` |

`get_public_brand` / `compare_public_brands` `view` facets: `overview` (default) ·
`visibility` · `footprint` · `competitors` · `citations` · `category_ranking` · `revenue` ·
`shopping` · `citation_totals` (true usable-citation total inside the window — the denominator
the capped `citations` rows understate). (`compare_public_brands` defaults to `visibility`.)
**Deprecated (2026-09, removed next release, still served with `_deprecated`)**:
`exposure_quality` · `segments` · `topic_flow` · `presence_trend`.

> `view=competitors` returns head-to-head **wins/losses/ties totals** + `sharedTopicCount` per
> peer — the per-topic battle-cell detail shown in the app is omitted over MCP (payload size).

---

## 4. Category / product-space (3)

| Tool | Purpose | Key params |
|---|---|---|
| `get_public_category` | One product-space category, **faceted**. Windowed (30d batch default) on overview / brand_leaderboard / som_trend / topics / citation_domains — keep overview + leaderboard on one window (SoM denominator); recent_mentions is "latest", never windowed | `view (default overview), slug (required for overview), product_space_id (required for other views), country (default US), language (default en), limit (1–200), topic_ids[] (≤500), public_brand_id, range (30d\|60d\|90d\|all), date_from, date_to, max_points (2–90, default = window length)` |
| `get_category_whitespace` | Opportunity map for a subject brand: classifies topics into strengths (covered/leading/close/defend) vs opportunities (prioritize/gap/watch) | `product_space_id, public_brand_id, country (default US), language (default en), topic_ids[] (≤500), limit (1–50)` |
| `get_category_brand_momentum` | Period-over-period SoM change ranking: risers vs fallers, with window bounds | `product_space_id, country (default US), language (default en), days (2–45, default 7), date_to, public_brand_id, topic_ids[] (≤500), limit (1–50)` |

`get_public_category` `view` facets: `overview` · `brand_leaderboard` · `som_trend` ·
`topics` · `citation_domains` · `recent_mentions`.

> `view=citation_domains` returns top domains plus `totalCitations` / `totalDomains` that are
> **category-wide totals** (not just the returned rows) — safe as a share denominator. Since
> 2026-09 it counts **usable** citations only (aligned with `get_public_brand` view=citations
> and `get_public_topic_citation_domains`; the /category page changed with it).

---

## 5. AI-search query intelligence (1 + 1 deprecated alias)

| Tool | Purpose | Key params |
|---|---|---|
| `get_public_search_queries` | AI-search demand for a product-space, **faceted** — includes the two drill-downs: `query_detail` (one query: brands + prompts + top sources) and `theme_detail` (one topic) | `mode (default queries), product_space_id (required except `product_spaces` / `theme_detail`), query (query_detail mode), topic_id (theme_detail mode), country (default US), language (default en), page, page_size (10–100, default 20), search, coverage: all\|2plus\|3plus\|5plus, sort` |

`get_public_search_queries` `mode` facets: `territories` · `product_spaces` · `query_detail` ·
`theme_detail`; **deprecated (2026-09, removed next release, still served with `_deprecated`)**:
`queries` (still the enum default for compatibility) · `themes` · `brand_landscape` · `prompt_map`
— the /industry/search page moved to a global batch-anchored model on 2026-07-23 and these
all-history readers have no page equivalent. Prefer `territories` + mode=`query_detail`.

> `mode=territories` — the demand-territory map: which brand OWNS each cross-topic demand root
> (category leader's territory + challenger territories; each root has `span` = topics covered
> and `share` = the leader's record share; `truncated=true` means the category was too large to
> compute exactly and results were withheld). Territories only counts `web_search_query`
> rewrites — its record counts are **not comparable** with the `queries` facet.
>
> **Echo exclusion (all modes)**: rewrites that are just the user prompt bounced back verbatim
> are excluded from every facet. Query counts pulled before 2026-07-23 ran higher — old numbers
> will not reconcile with fresh pulls; the fresh ones are correct.

---

## 6. Shopping (3 + 1 deprecated alias)

| Tool | Purpose | Key params |
|---|---|---|
| `list_public_shopping_boards` | **Cross-category AI shelf leaderboard** (the /shopping page): which products AI recommends most across ALL categories, latest collection batch. Three boards: `hot` (most answer appearances), `climbers` (biggest rank gains vs previous batch), `entrants` (new to the board). Items carry `rank`/`rankPrev`, `appearances`/`appearancesPrev` (batch-counted), `productId`, `productSpaceId`. `comparable=false` → no previous batch (climbers/entrants empty); `batchSuspect=true` → batch looks under-collected, treat ranks with caution. **Batch semantics ≠ the rolling-window grid below — counts will not match between the two** | `board: hot\|climbers\|entrants\|all (default all), limit (1–50, default 10), country, language, platform` |
| `get_public_shopping_product_detail` | **One product's FULL analysis** (the /product page, `mode=full`, default): identity + KPI counts (topicCount, recordsAppeared, shelfScore 0–1), per-topic shelves, weekly position-band trend, rivals (co-occurring competitors head-to-head), top-5-shelves × top-8-products competition grid, attributes/purchase observations, channel classification (official/marketplace/aggregator). `mode=card` = the cheap entity-level **preview** instead (header, brand, evidence, top topics, retail offers; needs `product_space_id`; `data` is null when the product has no rows in the window). Response is large — narrow with `days` if truncated | `product_id (ptsp_*), mode (full\|card), product_space_id (card mode), country, language, days (1–90, default 30), to (YYYY-MM-DD — pin a historical window end, inclusive; honored by both modes, omit = rolling latest), platform` |
| `list_public_shopping_products` | **One category's AI shelf** (the /category page shelf section, since 2026-09 — was a rolling-days grid with no page equivalent): latest published batch vs previous batch, paginated `cards` over the top-100 ranking (rank/rankPrev, appearances/appearancesPrev, brand, price median, topic coverage, `productId`) with `page`/`pageSize`/`total`/`totalPages`/`hasMore`, `channels`, price quartiles, per-tier leaders; `batchDate`/`prevBatchDate`/`comparable`. With `search` the hit set (≤12 best title matches, the page's cap) replaces the ranking and is paged by the same `page`/`page_size` — `total` then counts hits | `product_space_id, country (default US), language (default en), topic_ids[] (≤50), search (≥2 chars, in-batch title match), page, page_size (1–100, default 12)` |

---

## Competitive-intelligence playbook (question → tool chain)

- **"How do we rank in <category> and who leads?"**
  `search_public_entities` (resolve category + my brand) → `get_public_category` view=`brand_leaderboard`
  → `get_public_brand` view=`category_ranking`.

- **"Where should we invest — what topics can we win?"**
  `get_category_whitespace` (subject = my `public_brand_id`). Act on the `prioritize` / `gap`
  buckets; `defend` = leads at risk.

- **"Who's gaining/losing share lately?"**
  `get_category_brand_momentum` (risers vs fallers over `days`). Drill a riser with
  `get_public_topic_som_trend`.

- **"What is AI actually being asked in our space, and who wins those answers?"**
  `get_public_search_queries` mode=`territories` (demand roots + who owns them) → same tool
  mode=`query_detail` for the winners + sources of one query.
  (`queries` / `brand_landscape` modes are deprecated.)

- **"How does AI describe us vs a rival?"**
  `compare_public_brands` view=`visibility` (or `competitors`), **country+language required** →
  `get_public_brand_perception` per brand → same tool mode=`aspect_mentions` for evidence.

- **"Is this topic worth targeting?"**
  `get_topic_competition_difficulty` (0–100; higher = more concentrated/harder) +
  `get_public_topic_brand_leaderboard` to see who holds it.

- **"What's trending on the AI shopping shelf?"**
  `list_public_shopping_boards` (hot / climbers / entrants) → drill any `productId` with
  `get_public_shopping_product_detail` (shelves, weekly trend, rivals, channels).

- **"Which demand roots does each brand own in our category?"**
  `get_public_search_queries` mode=`territories` — leader vs challenger territories; drill a
  root's queries via mode=`query_detail`.

- **"In which contexts does a source domain push AI toward a competitor?"**
  `get_public_sources_overview` / `get_public_source_domain_detail` (co-occurring brands, no
  plan gate) → `get_public_source_brand_conduit` (domain × brand → the exact topics).

## Caveats specific to public tools

- **Window first**: start cross-brand work with `get_public_data_window` (free) and keep every
  tool on the same `range`; quote the echoed `window.from`–`window.to` as the "as of" range.
  A public number without its window is not reportable.
- **Separate pipeline**: do not reconcile public numbers against the self-surface
  (`get_brand_overview`) — different collection, possibly different cadence.
- **Platform defaulting**: every data tool defaults to `platform=chatgpt`. Numbers are
  ChatGPT-only unless you discover other platforms via `get_available_platforms` and pass
  `platform` explicitly. When a scope has multiple platforms, say which platform a figure is
  for; don't imply it's all of AI.
- **Locale defaulting**: always check `defaulted`; surface it.
- **Truncation**: public responses cap at ~120k chars; an over-cap response comes back as a
  JSON envelope `{ "_truncated": true, "_message": …, "preview": … }` (the preview is the
  beginning of the original JSON, NOT complete). Narrow by topic/locale/date or paginate.
- **Ranks are absolute** (1-based leaderboard position), not relative to the returned page.
