# Changelog

All notable changes to the `geoly-mcp` agent skill.

## 0.6.0

**Tool surface = page caliber.** A 23-PR sweep that aligns every MCP / Agent API / Sidekick
tool with the in-app page it mirrors (same read model, filters, windows and field meanings).

**Breaking — unknown arguments are now rejected.** All three surfaces validate tool input
strictly: an argument the tool does not declare returns an input-validation error (MCP
`-32602`) listing the accepted arguments, before the tool runs and before anything is billed.
Previously such keys were silently dropped and the call ran with defaults — which is how a
misspelled `sort_order` returned the ascending default and looked like "all zeros". `org_id` /
`brand_id` stay accepted on every tool. If a call that used to work now errors, fix the
argument name the error points at.

**New tools:** `get_audit_pages` (per-page audit checks, paginated, free) and
`get_cf_traffic_data` (Cloudflare traffic, free). `get_agent_ready_scans` /
`get_agent_ready_scan_detail` are now also available to the hosted Agent API.

- **`get_prompt_detail` catches up with three things the `/prompts/[id]` page has and the tool
  did not.** `sources_page` (1–1000) pages `sourceDomains.rows` the way the page's sources tab
  does — the tool used to return page 1 only (10 root domains) with no way to ask for the rest,
  and the response now echoes `page` / `pageSize`; `breakdown` / `ownDomains` /
  `totalDomainCount` stay window-wide on every page. `trend_granularity` (`day` default /
  `week` / `month`) buckets `overview.benchmarkTrend` with the page's own aggregation (days
  averaged with equal weight; with week/month `date` is the bucket start — ISO Monday or the
  1st), echoed back as `overview.trendGranularity`; note the page defaults to **week** on
  30d/custom. And `overview.brandRank` finally answers "where do I rank on this prompt":
  `visibilityBoard` lists **competitors only** (it never contained your own brand, which was
  not documented), so rank = board rows beating `brandVisibilityScore` + 1 — the exact position
  the page inserts your row at. It is `null` when the window has no completed records, matching
  the page, which draws no board and no rank in that state (an empty board with records in the
  window still ranks you 1, same as the page).
- **`get_prompt_mention_rates` gains `sort_by` / `sort_order` / `offset` / `topic_ids`** (plus a
  `topic_id` single-id alias) and returns `total` with an echo of the paging and sort arguments.
  A user report: `offset=100` and `offset=0` returned the same 100 rows, `sort_by=mentionRate&sort_order=desc`
  returned 100 rows that were all zero, and `topic_id` did not filter — those keys were not in the
  tool's schema and were being silently dropped. Note the default is still **rankedRate ascending =
  blind spots first**, so the first page is *expected* to be zeros; pass `sort_order=desc` for the
  prompts where the brand is mentioned most. Topic ids come from `get_topic_list` / `get_brand_context`;
  the 50-id cap applies to `topic_ids` **merged with** `topic_id` and de-duplicated, and going over it
  returns an error rather than quietly dropping the extra topic.
- **Unknown arguments are now rejected instead of silently dropped** on MCP, Sidekick and the Agent
  API. Calling a tool with a parameter it does not have returns an error naming the unknown keys and
  listing the accepted parameter names, rather than running the call as if the parameter had been
  given. `org_id` / `brand_id` stay accepted everywhere (ignored by the tools that are not
  brand-scoped). The only JSON-schema change is `additionalProperties: false`.
- **`get_brand_search_queries` follows the `/sources/queries` page's states, not just its numbers.**
  Above the sample safety cap `mode=overview` / `mode=groups` now return
  `{ error: "Sample above the safety cap …", truncated: true }` instead of the all-zero
  skeleton the read model hands back — the page blanks the whole screen there, so quoting
  `searchTriggered.value = 0` was reporting the opposite of the truth. Passing a platform that
  does not expose search queries (anything but `chatgpt` / `perplexity`) now returns an explicit
  error without reading anything, and a platform the brand is not entitled to returns a separate
  "not entitled for this brand" error; both used to collapse into "No search-query data for this
  brand". New `topic_ids` (the page's multi-select topic chip, up to 50 — multi-topic rates and
  distinct counts cannot be rebuilt by adding up single-topic calls; `topic_id` stays as the
  single alias), `groups` rows gain `lastRecordDate` (the last business day that query showed
  up, already in the page's CSV export), and the description now spells out the calibers an
  agent otherwise has to guess: rates are 0–1 fractions with "—" for a zero denominator,
  `delta` is the equal-length previous window and `delta = null` means "no comparison
  available" (not +100%), `intentRows` / `unverified` / the three `cited` states / the three
  grey-row states, `brandNamedrops[].key` is a normalized key (display `displayName`), and
  `query_detail` without `prompt_id` totals across every prompt while the in-app drawer is
  always scoped to one (query, prompt) pair.
- `get_competitor_polarity`：新增 `topic_ids`（≤50，= 页面主题 chip）；返回体加 `topicIds` / `ready` / `generation` / `builtAt`。`ready=false` 表示该品牌还没有认知画像 rollup pointer —— 页面此刻整块是空态，别把工具算出来的榜当成页面数字念。 另加 `note`（通常 `null`）：冷查询期间 rollup 若发了新一代，工具走与页面同一套换代复核（算完复读 pointer，最多重试 2 次），仍钉不住一代时照常给数但标上 `note` 且**不写缓存**，不会出现「gen 7 的标签 + gen 8 的榜」。
- `get_risk_context_sources`：**缺省窗口仍是 7d**（页面与同页 `get_competitor_polarity` 是 30d）——差异改由描述首段显式声明，传 `time_range=30d` 才是页面口径；缺省不动的理由是实测：30d 冷调在两个头部品牌是 50.9s / 81.2s，越过本工具 45s 档，改缺省会把所有不传窗口的既有调用方推过去。新增 `topic_ids` / `aspect_id` / `kind` / `q` 四个筛选（= 页面 Tab 上那四个控件），返回体加 `filtersApplied`；`rows[].topAspects` 由 label 字符串改回 `{aspectId,label,labelZh}` 对象（aspectId 可直接回填 `aspect_id`）。⚠️ `kind` / `q` 会收窄口径，此时 `kpis.domainsDelta` 为 `null`。 两个工具的 `topic_ids` 单项与 `aspect_id` 都**先 trim 再判**非空与字符界（1–64，与读模型丢弃超长 id 的阈值同源）：超长或纯空白的 id 直接被入参校验拒掉，不再在读模型里被静默丢掉（丢掉等于把筛选悄悄放宽成「全部主题」）。
- 两个评价页工具 + `get_sentiment_dashboard` + `get_competitor_cooccurrence` 的平台白名单补上 **copilot**（此前硬编码五码，买了 copilot 的品牌页面筛得到、工具报未知平台）；白名单与四处参数说明、错误文案现在同出一份常量（`ALL_SUPPORTED_PLATFORMS`），不再各抄一份；`get_sentiment_dashboard` / `get_competitor_cooccurrence` 两个 `platform` 仍是自由字符串的工具，现在在 handler 里**真正执行**这份白名单——`ai_platform` 里有行但不在支持列表里的 `grok` 一律回 `{error}`，不再放行进查询（此前只判「字典里有没有」，grok 会静默查出空结果）。
- `get_sentiment_dashboard`：描述首句改成「不是 /performance/verdict 的口径」（那页是属性票，这里是 record 级旧标签）；登记 45s 超时档并**配上 5 分钟结果缓存**（45s 档的超时提示会承诺「跑完即缓存、重试即命中」，没有缓存壳那句就是假话）——缓存只存**已授权品牌的成功结果**，键含 brandId，作用域/入参失败（`null`）一律不写缓存。
- `get_competitor_cooccurrence`：未知平台码改为返回 `{error}`（此前静默空结果）；`summary.byPlatform[]` 加 `platformCode`；描述标明 `rows[].sentiment` 是 record 级旧标签。
- **`query_analytics` tells you which calendar it is on, and can speak the app's one.**
  The `date` dimension has always been `record_date` truncated to a **UTC** day key, which is
  the in-app (UTC+8) business day **minus one** — so every date quoted from this tool was a day
  early. The description now says so, and a new `businessDate` dimension (pairs with `date`,
  derived, no extra query) returns the business-day label the app plots. Daily
  `aigvr` / `mentionRate` / `citationRate` are now rounded to **1 decimal** like the in-app trend
  chart instead of to whole numbers (they also feed the tool's own re-aggregation, where
  pre-rounding was inflating the window value).
- **`query_analytics` gains the `/performance` topic + country filters** (`dataset=brand_citations_daily`):
  `topic_ids[]` (multi-select; `"_none"` = prompts without a topic, legacy alias `"_ungrouped"`
  accepted, 1–50 ids) and `country` (ISO-2). They are validated against the brand exactly as the
  page does — unknown ids / countries are **rejected**, never silently dropped, and so are blank
  values and an empty list (omit the parameter for "no filter"); selecting everything is treated as
  "no filter" and the response then echoes `filters.topicIds=null` / `filters.country=null` plus a
  `filters.scopeNote`, so a folded filter can never be mistaken for a real one. A filtered daily
  series now matches the filtered trend chart instead of quietly being the whole brand. Passing
  them to any other dataset is an error, not a silent no-op. `topic_citations_daily`'s single
  `topic_id` now also accepts `"_none"` (and works on `topic_domain_citations_daily` too, as it
  always did — the description said otherwise).
- **Public brand tools now answer with the /brand page's own numbers** (tool-vs-page parity pass):
  - `get_public_brand` view=`visibility` **truncates the trend at a collection-scale breakpoint**
    the way the page chart does (points before the breakpoint dropped, `netChangePp=null`,
    avg/peak/trough recomputed inside the surviving generation, `trend.truncatedFrom` set), and
    **withholds the trend entirely** (`trend:null` + `trendUnavailable`) when the platform has no
    published batch — the page hides that chart rather than anchoring on `max(record_date)`. The
    window echo gained `fallback:"no_published_batch"` so that state is distinguishable from
    `range="all"`.
  - `view="revenue"` returns `{notApplicable:true}` on `platform="google_ai_overview"` — the
    AI-traffic calibration is built on AI-chat click behaviour and the page shows "—" there.
  - `view="competitors"` adds `subjectVisibility` and a per-row `isThreat`
    (`peerVisibility > subjectVisibility` on the SAME window) — the page's threat flag; both are
    `null` for a gated subject.
  - `view="footprint"` accepts **`product_space_id`** (the literal `"uncategorized"` = topics with
    no product space), the scoping the page's category drawer always applies.
  - Empty or all-zero payloads now come back with `availablePlatforms` (the platforms this brand
    is actually observed on) and, for a **merged** brand id, `redirectToBrandId` — the survivor the
    page 301-redirects to. `compare_public_brands` carries the same per-brand fields.
  - `view="overview"` description corrected: its `topicCount` is all-history and **no page shows
    it** — the "covers N topics" line is `view="competitors"` → `brandTopicCount`.
- **Removed (step ③ of the 2026-09 retirement): `get_public_brand` / `compare_public_brands`
  view=`exposure_quality`, `segments`, `topic_flow`, `presence_trend`.** The enum now rejects
  them. Use `visibility` (+`include_trend`), `competitors` and `footprint` on the same window and
  diff two windows yourself for movement.
- **`compare_public_brands` default `view="visibility"` documented correctly**: it returns each
  brand's `visibilityScore` = M2 Category Share of Voice 0–100, the same number the /brand KPI
  ring shows (gated ⇒ `null` = insufficient sample, never zero). The old "headline geoScore /
  leader-relative attainment / legacy visibilityScore" wording described a metric that was rolled
  back on 2026-07-30 and never shipped.
- **`get_public_brand_perception`**: every aspect now carries `bucket` — the page's own
  strength / mixed / weakness classification (weakness = negative≥2 and net≤-20; mixed =
  negative≥2 and negative share≥30%; strength = net≥30 and negative share<30%) — plus
  `strengths` / `mixed` / `weaknesses` label lists in the page's order. `mode="aspect_mentions"`
  now accepts `range` / `date_from` / `date_to` and echoes `caliber`: the drill-down must use the
  same window as the profile it drills into. The deprecated alias
  `get_public_brand_perception_aspect_mentions` forwards the three window parameters too. The
  all-history default is unchanged and is the `/brand/[id]/report` caliber; the /brand card is
  `range=30d`.
- **`get_public_data_window` accepts `brand_id`** (+`country`/`language`, optional `report_days`
  7–90) and adds `reportAnchor` — the window `/brand/[id]/report` uses, anchored on that brand's
  own high-water mark rather than the platform batch. It is a different anchor from everything
  else this tool returns; never reconcile figures across the two. `report_days` only applies
  together with `brand_id` and is ignored without it.
- **`get_brand_board` gains `include_trend`** (default false) — the in-app `/performance` trend
  chart: `trend[]` with one point per **UTC+8 business day** (`completedRecords`,
  `brandMentionedRecords`, `brandVisibility` and the top-4 competitor lines) plus
  `trendCompetitors` for the legend. Raw numerator and denominator are on every point, so weekly
  / monthly buckets must be re-divided from those sums, never averaged from the daily
  percentages. Confirmed mode only (with `topic_ids`/`country` the page's own chart falls back to
  the legacy caliber, so the flag is ignored and the response says so).
- **The trend self-reports its own gaps and its own cap** — `trendDays`, `trendFirstDay`,
  `trendLatestDay`, `trendTruncated` ship with every `include_trend=true` response. It is **not**
  one point per day of the window: days before `coverage.floorDay`, mid-window days the counting
  lane has not reached, and the last 1–3 days with under 90% of completed answers counted are all
  dropped whole — **yesterday is frequently absent**, and `coverage` only ever described the first
  of those three. Check `trendLatestDay` before answering anything day-specific. Long windows
  (180d ≈ 94k characters of JSON) are capped inside the tool so neither of the host's generic
  output limits can fire — not the 60k whole-response one and not the 48k single-array one: the
  **newest** days are kept and `trendTruncated=true` says the oldest were dropped — the
  generic limiter would have done the opposite (kept the oldest, or replaced the whole response
  with an invalid JSON preview, the same user-visible failure recorded for `get_competitor_list`
  below).
- **`trend[].brandVisibility` / `brandMentionedRecords` are `null`, not `0`, when
  `ownBrand.pending=true`** (the tenant has no own-brand entity built yet — 111 of them in
  production). The read model's `0` is placeholder data; the in-app chart hides the own-brand
  series entirely in that state, and `ownBrand.visibility` in the same response is already `null`.
  Competitor lines are unaffected. Never draw or quote a 0% own-brand line.
- **`get_brand_board` under `topic_ids`/`country` now reports its own caliber**
  (`caliber=scoped_open_world_v0` instead of `brand_entity_v1`), and rows carry the
  self-describing `pooledMentionRate` / `candidateShare` next to the unchanged `visibility` /
  `share` aliases. Only the **row source** of that mode matches the in-app filtered board: the
  page still renders the legacy merged board there (old day-averaged visibility + old SoM matched
  by name, legacy-only rows added back, sorted by visibility), so the old description's "the same
  board as the in-app /performance overview" was only ever true without a filter. Unfiltered
  (`mode=confirmed`) is unchanged and still value-for-value the page board. **If you branch on
  `caliber === "brand_entity_v1"`, filtered responses now take the `else` path** — the field name
  and every existing field are unchanged, only that one value differs under a filter.
- **`get_brand_overview` now answers the whole `/performance` KPI row, with the page's own
  filters.** New parameters: `time_range` also accepts `180d` and `custom` (+ `start_date` /
  `end_date`, span clamped to 90 days), `platform` (entitlement-checked — an unknown or
  unentitled code is an error, never a silent fall back to all platforms), `topic_ids[]`
  (`"_none"` = prompts without a topic) and `country`; all of them narrow **every** number in
  the response. New fields: `shareOfVoice { brandMentionedRecords, totalSomMentionedRecords,
  share }` (the Share-of-voice cell, **legacy discovered-brand caliber** — not
  `get_brand_board.ownBrand.share` and not `get_platform_matrix` SoM; `null` +
  `shareOfVoiceState:"not-ready"` when the derived daily layer isn't ready for the window),
  `bestPlatform` / `worstPlatform` (both `null` when fewer than two platforms have data),
  `platformStats[].mentionRate`, and the echoes `window {timeRange,start,end,endBounded}`,
  `platform`, `scope {active,topicIds,country}`, `kpiState`. `kpiState:"unavailable"` means a
  **filtered** KPI query exceeded its 10s budget — you get no numbers rather than unfiltered ones.
  `window.start` / `window.end` are **full ISO instants** (same shape as `get_brand_board`): a
  `custom` `start_date` is a +08 business day whose first instant is `T16:00:00Z` the day before,
  so quote the business days you asked for and never the sliced-off UTC date. `start_date` /
  `end_date` are read **only** with `time_range=custom`; passed with any other range they are
  ignored and `window.note` says so. When the window/scope has no completed records
  (`hasCompletedRecords:false`, `aigvr.totalCount:0`) the scores and rates are 0 placeholders and
  a `_message` says so — answer "no data for this filter", never "0% visibility".
- **`get_brand_overview.platformStats[].aigvrScore` / `citationRate` can now be `null`** — a
  platform with no completed records in the window used to report `0`, which read as "worst
  platform" instead of "not run". Rates on those rows are also 1-decimal now (same rounding as
  the headline) instead of whole numbers.
- **New: `get_cf_traffic_data`** — the Cloudflare tab of `/sources/traffic` (AI **crawlers** fetching
  your pages, not visitors arriving from AI answers): `aiCrawlerRequests`, per-crawler stats,
  the crawler → path Sankey breakdown, `topCrawledPaths` (top 10 — the read model's own cap),
  daily trend, countries (top 10), the uncapped `blockedCrawlerSummary` ranking and
  `blockedEvents` (capped by the new `blocked_events_limit`, default 50 = the in-app table, max
  2000 = the read model's cap; `blockedEventsTruncated {returned,total}` says when rows were
  dropped), plus `maxDays` (the zone's Cloudflare plan retention, which clamps the window) and
  `degraded.previousPeriod` / `degraded.blockedEvents` — when those are true a null change or an
  empty blocked list means the fetch FAILED, not that nothing happened. Note `changes.blockedEvents`
  is **always null**: the firewall side has no previous-period query, so it is "never computed",
  not "no blocking last period". Default window **7d** (the tab's own default; Cloudflare is
  queried one batch per day). Free, like the GA4 tools.
  Not connected ⇒ `{ success:false, error:"CF_NOT_CONNECTED" }`.
- **`get_ga4_traffic_data` gains `time_range:"custom"`** with `start_date` / `end_date` — the page's
  own date picker window, in both the property-wide and the `page_path` mode (`get_ga4_page_data`
  accepts them too). Trend granularity follows the span like the page: daily ≤60 days,
  weekly 61-180, monthly beyond, echoed in `trendGranularity`.
- **`get_ga4_traffic_data` gains `platforms` and `landing_page_limit`** — the page's platform filter
  and its top-25 landing-page table. They narrow only the per-platform collections
  (`aiSources`, `platformLandingPages`, `platformDurations`, the `platforms` maps inside the trends);
  every total stays whole, so a filtered call still reports the brand's real AI totals.
- **`get_ga4_traffic_data` caliber is now spelled out in its description**: which fields are
  WHOLE-SITE (`metrics`, `changes`, `timeSeries`, `landingPages`, `channelDistribution`) and which
  cover only AI-referred sessions; that the in-app page renders neither `landingPages` nor
  `timeSeries`; that the page's channel chart subtracts `totalAiSessions` from `Referral` and shows
  it as a synthetic "AI Traffic" channel while `channelDistribution` is raw GA4; and that the page
  opens on **7d** while the tool keeps the 30d tool-face default.
- **`get_agent_ready_scan_detail` now speaks the /tools/agent-ready page's language.** New
  `summary` = the page's top score card: `overallScore` 0-100 over the **four main categories**
  (commerce never counts), per-category `{key, label, score, pass, total}` and
  `commerce {score, pass, total, applicable}` — always computed on the **unfiltered** checks,
  the way the page's card ignores its own "Customize view" filter. Every check is enriched with
  the copy the page shows on each card (`label`, `goal`, `howToImplement`, `specUrls` with
  comma-packed upstream values split out, `skillUrl`), falling back to a static catalog for
  checks absent from `nextLevel.requirements` (it only covers the path to the NEXT level).
  New `shareUrl` (the link the page's Share button copies; null until a share link exists) and
  new display filters `preset` (all / content / api), `checks[]` and `include_evidence`
  (default true — pass false to drop the per-check audit steps, by far the bulkiest part).
  `status` caliber is now stated in the description: `unableToCheck` counts in the denominator
  but not the numerator, `neutral` is excluded from both, checks are grouped by **5 categories**
  (not per level), and upstream results are cached 24h per URL.
- **The Agent Readiness tools are now on the hosted Agent API too** (`get_agent_ready_scans` /
  `get_agent_ready_scan_detail`, findable via `find_tools`). They stay USER-scoped — bound to
  the token owner, never to the brand — and free.
- **The 90-day window plan gate now holds on every surface, and a clamped window always says
  so.** It used to run only on the MCP registration path, so the same public tools accepted
  `90d` (and `days`/explicit windows over 60 days) unclamped from Sidekick and the hosted Agent
  API. All three surfaces now apply the same clamp to 60 days when the organization the call
  runs for (billed org on MCP, the brand's org in-app) lacks Advanced+, and the response says
  which span was refused — mirroring the web page's "this range needs Advanced+" notice. Never
  label clamped figures with the span you requested.
  - **Windowed tools** carry it in `window.`**`deniedRange`** (what you asked for, e.g. `"90d"`)
    plus a `note`; `window.range`/`from`/`to` are the truth. Triggered by `range=90d` or an
    explicit `date_from`+`date_to` span over 60 days on `get_public_brand`,
    `compare_public_brands`, `get_public_brand_perception`, `get_public_category` and the five
    windowed topic tools (`get_public_topic_brand_leaderboard`, `get_public_topic_som_trend`,
    `get_public_topic_prompt_matrix`, `list_public_topic_prompts`,
    `get_public_topic_citation_domains`).
  - **`get_public_shopping_product_detail`** and its deprecated alias
    **`get_public_shopping_card_detail`** have no `window` echo — `days` (up to 90 / 180) *is*
    their rolling window — so a clamped lookback shows up as a top-level **`rangeDenied`**
    `{requested, applied, note}` instead.
  - Not a window: `days` on `get_public_brand` / `compare_public_brands` is the visibility
    **trend point cap**, not a time window. It is capped at 60 too, but the window you get is
    the one `window` already reports, so it is deliberately *not* reported as `deniedRange`.
- **`get_brand_context` catches up with the pages it orients on** (page-parity audit
  2026-09-22): `competitors` now reads the **entity-layer brand library** — the same rows as
  Settings › Brand › Brands and `get_competitor_list status="tracked"` (own-brand row excluded) —
  instead of the legacy competitor table, which new brands never populate; rows carry
  `entity_id` / `root_domain` / `mentions_30d` next to the legacy `id` / `domains` / `aliases`
  (user-added spellings only) / `isActive`, plus `competitor_counts`. New fields: `brand.industry`
  / `description` / `logo_url` (the profile page), `integrations {ga4, cloudflare}` (the
  /sources/traffic readiness flags), `first_run` (the /performance first-collection state),
  `platforms[].entitled` with entitled-but-empty platforms listed at 0 (the page's platform chips),
  and `scope_universe {countries, has_ungrouped_prompts, ungrouped_topic_id}` (the page's filter
  universe). `get_competitor_list` remains the tool for suggestions, removed brands and learned
  spellings — and note its `aliases` lists **all** spellings while `get_brand_context.aliases`
  lists only the user-added ones, so the two are not diffable.
- **`scope_universe.countries` is a picking list, not a guard rail.** Only `get_brand_board`
  validates `country` against it (`error: "unknown_country"` with `knownCountries`);
  `list_brand_answers` does not validate country at all — an unknown code silently returns an
  empty list. Pick the value from `countries` yourself.
- **`get_ga4_traffic_data` now documents its not-ready codes** — `NO_PROPERTY_BOUND`,
  `PROPERTY_NOT_ALLOWED`, `USER_NOT_AUTHORIZED_WITH_GOOGLE`, `INSUFFICIENT_SCOPES`,
  `FAILED_TO_FETCH_TRAFFIC_DATA` / `FAILED_TO_FETCH_PAGE_DATA`. They arrive as
  `{ success:false, error }`, never an exception, and mean "not connected", not "zero traffic";
  `get_brand_context.integrations` pre-answers the first one (and the Cloudflare side's
  `CF_NOT_CONNECTED`, which has no tool of its own yet).
- **`get_competitor_list` replays the page's name column and header sort** — every spelling
  carries `is_distinct` (false = a variant the Settings › Brand name column folds away, e.g. a
  model name that contains a shorter spelling of the same entity); `names=summary` puts distinct
  learned spellings first; own-brand rows carry `primary_name` (the locked brand-name spelling);
  new `sort` (`mentions` | `name`) + `order` (`asc` | `desc`) sort inside each status group with
  the own-brand row pinned first, exactly like the page; the envelope carries `rescan_enabled`.
  With `entity_id` + `names="full"` the variant fold is computed over the spellings on the
  returned page plus your user-added ones instead of the entity's whole dictionary (it used to
  compare every spelling against every other one — thousands of them for a large own-brand
  entity — just to label the 500 a page actually returns), so a spelling can read as distinct on
  one page while a shorter variant of it sits on another. That comparison set is capped at 600
  spellings (the page, the entity's 100 shortest user-added ones looked up independently of the
  page window so a short spelling sorted onto a later page still folds the variants that contain
  it, and the own-brand primary name, which is always kept and never counts against those 100),
  so an account that has topped the same brand up thousands of times still gets a bounded
  comparison.
- **`create_competitor` now runs the Settings › Brand "add brand" path** instead of the legacy
  competitor-table write: a name already belonging to a suggested / removed brand re-tracks that
  entity (`adopted_existing=true`); own-brand names (`is_own_brand`), already-tracked brands
  (`already_exists`), invalid names and unusable domains (`invalid_domain` / `platform_domain` /
  `domain_taken` / `domain_name_clash`) come back as `{ success:false, errorCode }` instead of a
  thrown error; `aliases[]` are attached one by one AFTER creation under the page's no-steal rule
  (previously they were handed to the entity bridge wholesale, which could silently move a
  visible auto-discovered brand's spellings and history onto the new competitor) — **every** alias
  comes back in `spellings[] {name, result}` (`added` | `already_present` | `duplicate` |
  `name_taken` | `invalid_name` | `entity_unavailable` | `failed` | `not_attempted`); the response
  adds `entity_id`, `status`, `root_domain`, `rescan_enabled` + `effective_from` (`now` |
  `next_collection`, the same hint the page shows after every edit — the tool path now honours the
  rescan gate too; `next_collection` means the change applies from the next collection run and
  existing answers are re-counted in a later maintenance pass, **not** that they stay uncounted)
  and keeps the legacy `data` row. Parameters unchanged apart from new caps (`domains[]` ≤20 and each domain ≤253
  characters, `aliases[]` ≤20, since each alias is a separate serial write): the whole write path —
  the brand row, every attach and the legacy alias write-back, including the reads each one does
  before its transaction —
  shares one ~18s deadline and every transaction caps its statements at 2s DB-side, so past the
  deadline nothing new is started (`deadline_exceeded` on the brand step, `not_attempted` on the
  remaining spellings) and a timed-out call leaves at most one spelling write finishing in the
  background; repeating the call is idempotent. Only `domains[0]` becomes the
  entity `root_domain`, the rest stay on the legacy row for /sources/citations, and the legacy
  `aliases` column keeps carrying the spellings that actually landed on the brand
  (`added` + `already_present`) — the ones the no-steal rule refused are not written to it.
- **`create_competitor` on an already-tracked brand is now an idempotent top-up, not an error.**
  Adding a brand that is already in the library used to come back `already_exists` and do nothing,
  which also made the "just call it again" advice for a failed legacy alias write impossible to
  follow (the retry stopped at that guard before any spelling or legacy write was attempted). The
  call now returns `success:true` with `outcome:"already_tracked"` (new field; `created` |
  `adopted` | `already_tracked`, with `adopted_existing` true for the latter two): no second brand
  is minted, `domains` are ignored, the aliases you pass are attached to the existing brand
  (`already_present` for the ones it already has) and the legacy alias column is rewritten — so
  repeating the call is how a failed legacy write is repaired. `errorCode: already_exists` is left
  only for a name that collides with a tracked brand which cannot be located as an entity. A brand
  that exists in the entity layer only (system-discovered, never a legacy competitor row) answers
  with `data: null` and `legacy_aliases_synced: false` plus a note saying a retry will not change
  that.
- **`create_competitor` self-reports `legacy_aliases_synced`.** Mirroring the landed spellings
  onto the legacy `competitor.aliases` column happens outside the create transaction and can
  fail; the response used to stay `success:true` with `data.aliases` listing spellings that were
  never written there, while `/sources/citations` owned-vs-rival classification and the
  ingestion-time competitor matcher silently missed them. Now `legacy_aliases_synced:false`
  says so, `data.aliases` reports what that column **actually** holds (the pre-mirror value, or
  `null` when even that could not be read) instead of what was attached, and a `note` explains
  the retry — the mirror is a merge (case-insensitive set) rather than an overwrite, so calling
  `create_competitor` again with the same name and aliases duplicates nothing and does repair the
  column (it lands on the `already_tracked` path above). The merge also normalises what it finds:
  a column holding malformed entries is rewritten even when the count matches, and the write is
  confirmed by its affected-row count, so a row deleted between the read and the write reports
  `legacy_aliases_synced:false` instead of a silent success. The read-merge-write runs in one
  transaction under a row lock, so two calls landing on the same brand at the same time keep both
  sets of spellings instead of the later one overwriting the earlier. When a call attaches no new
  spellings at all (none passed, or every one refused by the no-steal rule) nothing is written and
  `data.aliases` reports the column's current contents rather than null.
- **`get_public_sources_overview` takes `platform`** (default chatgpt). The Sources list page has always been
  per-platform (the rollup key is domain × platform); the tool was pinned to chatgpt. The description now also
  states the calibers the page relies on: `share`'s denominator is that platform's global usable citations and a
  `type` filter never moves it, `lastRefreshed` is the rollup's own watermark (may be null / lag), and
  `integrityStatus` review|restricted is a neutral flag, not a score penalty.
- **`get_public_source_domain_detail` now returns the rest of the page's profile**: `categoryCount` (the third
  hero KPI), `keyRead` (`categoryFocus` vertical/broad/unclassified/insufficient + `topBrands`) and
  `categoryStanding` (weekly share trend; with the new `category_slug` also rank / poolSize / share inside that
  category). `period` now drives `categoryStanding.trend` as well as `topUrls`. Rows gained the page's two
  grouping labels: `topicCoverage[].stronghold` (dominance ≥ 0.15) and `topUrls[].archetype`
  (comparison|review|guide|question|other, a heuristic over English titles).
- **The three lists are pageable**: `list=topics|brands|urls` + `page` (0–25) — plus `topic_search` for the topic
  map's server-side name filter. The lists always reported `hasMore: true` with no way to fetch page 1. A `list=`
  call returns only that list plus the header (plus `categoryStanding` when `category_slug` is also given — an
  explicitly named scope is never silently dropped); `page` only applies together with `list`, so the full profile
  always keeps all three lists on page 0. Note `dominance`/`stronghold` are computed for the first 12 rows of
  page 0 only — null beyond that means NOT COMPUTED, not zero, and searching does NOT disable them (a searched
  page 0 still scores its first 12 matching rows) — and `keyRead.topBrands` is a different population from
  `coOccurringBrands` (domain-level rollup, no per-topic threshold, but the same ≥10 co-occurring-answers
  admission at the domain level), so the two lists can disagree.
- `get_public_source_domain_detail` moved to the **45s tier** (it was timing out on huge domains at the 15s
  default), and its timeout hint no longer suggests dropping `include_scorecard` or narrowing `period` — neither
  adds a query. It now points at pinning `platform` or fetching one list at a time.
- **`get_prompt_list` gains `compact=true`** (slim rows: id, text, country, isActive, topicName,
  tags, createdAt, recordsCount, visibility, mentionRate, citationRate) so a 100-row page fits
  the output cap — the way to enumerate / export every prompt (a full row is ~1.2KB, only ~45
  fit; the page is flagged `_truncated` when cut). Paging is now a total order (sort key, then
  createdAt, then id): bulk-imported prompts share one createdAt and used to overlap across pages.
- **`get_prompt_list` filters are ANDed like the page.** Passing `search` used to silently drop
  the `topic` / `topic_name` / `tags` filters, so "search X inside topic T" quietly returned
  matches from the whole brand. They are now all combined (`search AND topic AND tags AND
  country AND status`), and `search` is documented for what it has always matched: prompt text
  **or tag name**, case-insensitive substring.
- **`get_prompt_list` sorting follows the tab.** `sort_by` gains `archivedAt` and is now optional:
  omit it and you get the page default for the tab you asked for — `archivedAt` on
  `status=archived` (COALESCE(archived_at, updated_at)), `date` otherwise. `position` stays
  accepted but is tool-only: the page retired that column on 2026-09-11.
- **`get_prompt_list` rows carry four more page columns** (no extra query): `topicId` (needed to
  move / re-assign a prompt), `archivedAt`, `isBranded` (the page's "type" column: the prompt text
  contains one of the brand's match terms) and `inFlightCount` (records still pending/running
  inside the window and younger than 14h — `>0` means today's run has not finished).
- **`get_prompt_list` tells you the legal countries.** The response echoes `countryOptions[]`
  (the brand's actual country values = the page's country chips) whenever `country` is passed or
  the brand spans more than one country, and an unknown `country` now returns an error object
  listing them instead of a silently empty page.
- **`get_topic_list` documents both counts** — `activeCount` + `archivedCount` per topic
  (`promptCount` == `activeCount`), because a single `0` cannot distinguish "never had prompts"
  from "all of them are archived". Ungrouped prompts are not a row: use
  `get_prompt_list topic=['_none']` per `status` and read `totalRows`.
- **`get_topic_analytics` description rewritten to its real caliber** — it is the topic detail
  page's sentiment / response-type / competitor cards (`byTopic`), not a retired "Analysis ›
  Topics tab"; `global.*` has no page consumer; both trends are **weekly** (Asia/Shanghai)
  buckets, not daily; `time_range="all"` is floored to a trailing 30 days. Two scoping traps are
  now spelled out: topic-less prompts come back under `_ungrouped` **by default** (omitting
  `topic_ids` already includes them), and `include_ungrouped=true` **without** `topic_ids` does
  the opposite of what it sounds like — it narrows the scope to only topic-less prompts. Also
  corrected: `topCompetitors` are the other brands named in the same answers (with the
  brand-entity read on they are resolved entities and include your manually tracked
  competitors), and the competitor arm only reads the T3E derived layer when `platform="all"`
  and that layer is ready.
- **`org_id` / `brand_id` are accepted in every mode.** A single-org token passing another org's
  `org_id` now gets an explicit error instead of the request silently landing on its own org.
- **Numeric parameters accept numeric strings** ("2" → 2 — only numeric strings; null / booleans /
  blank strings are still rejected) on MCP, Sidekick and the Agent API;
  the JSON schema is unchanged. The hosted Agent API also now validates arguments and applies
  defaults before running a tool (it used to hand the model's raw JSON to the handler).
- **Citations catch up with the 2026-09-04 page redesign** (`/sources/citations`, domains tab):
  `get_citation_overview` gains `board` — the page's own read model (`totals`, `you {share, rank}`,
  `movers {top, new, up, down}`, `enteredTop20` / `biggestDrop`, `trend` top-5 + you,
  `typeShare`, `coverage`, `prevReady`) and the page filters `topic_ids` / `competitor_ids`
  (with those set the response is `{ board }` only). `stats` is unchanged for existing callers;
  `stats.trend.citations` (half-window vs half-window) is deprecated in favour of `board.movers`.
- **New: `list_citation_domains`** — the page's domain table (per-domain `prevCitations` /
  `deltaPct` / `isNew`, `selfMentioned`, mentioned `brands[]`, `search`, `type`, `sort`,
  paging up to 100) and its **content-gap switch** (`gap_only=true`: a registered competitor is
  mentioned in answers citing the domain and you are not). `get_content_opportunities` is
  deprecated: the page section it mirrored was removed in the redesign; the name keeps its old
  semantics and price.
- **`search_public_entities` now enforces the in-app search box's min-length guard.** `query`
  goes from `.min(2)` to `.min(3)`, and — like the ⌘K route — the word-length check runs
  *after* punctuation is normalised into word breaks, so `"hp-x"` (two short words) no longer
  searches. Failing the guard returns empty groups plus a `note` rather than an error, and
  nothing is queried; the old `productsNote` field is gone (a query short enough to trigger it
  can no longer reach the handler). Two-character queries used to degrade every UNION branch
  into a full `public_brand` scan (8.9s measured on the page side) with no statement timeout on
  this path.
- **Caliber notes on the two explore tools** (no behaviour change): `search_public_entities` is
  **not** windowed — it ranks brands on the cumulative `public_brand.total_mentions` column, so
  its counts do not reconcile with `get_public_data_window`; and `categories[].topicCount` /
  `brandCount` are **always `null` by design** (the per-keystroke count subqueries were dropped
  in 2026-08 — read counts from `get_public_category(view="overview")`). `get_public_data_window`
  no longer claims `/industry/explore` as a consumer, and documents that `country` yields
  **at most 2** `countryBatchDates` (`[previous, latest]`, the shopping-board anchor) rather than
  that country's batch history.
- **Citation tools validate `platform` at the tool boundary** (`get_citation_overview`,
  `list_citation_domains`, `get_domain_detail`, `get_page_detail`, `get_url_reference_detail`):
  the page's platform chips are the brand's *entitled* active platforms, so an unknown or
  un-entitled code now returns `{ error }` listing the allowed codes — previously the three
  detail/overview tools silently fell back to all platforms and `get_url_reference_detail`
  returned an all-zero result. The check is the page's own rule (**active** platform ∩ brand
  entitlement), so a code that is still in an org's entitlement list but no longer collected
  (`claude`, `grok`) is rejected as well instead of returning an empty window; codes are matched
  case-insensitively, and a brand with no entitled platform at all says so. The parameter
  description now lists `copilot`.
- **Share precision follows the page (one decimal)**: `get_domain_detail` / `get_page_detail`
  add `share` (raw 0–1, the value the page formats); `get_citation_overview` adds
  `stats.topDomains[].share` and `stats.platformDistribution[].share`. The old integer
  `percentage` / `ownership` points and the 2-decimal `citationShare` stay for existing callers
  but cannot be turned back into the page's number — the page's type-share card is
  `board.typeShare`. Two known non-matches stay documented rather than silently equated:
  `get_page_detail`'s `totalCitations` / `share` are **not** the pages-tab row (lookup-URL grain
  vs the table's raw url, and a denominator that keeps the search / redirect links the table
  drops), and `get_domain_detail`'s `pages[]` is the raw per-URL grouping, not the drill-down
  table (its `totalCitations` / `share` do match the drill-down KPI).
- Descriptions and this skill now name the real route `/sources/citations` (and the drill-down
  `/sources/citations/<root_domain>`); the old `/citations` path 404s. `get_url_reference_detail`
  states its tool-only caliber: lookup-URL grain + rolling / custom window, not the page row.
- **Category tools catch up with `/category/[slug]` and its printable report** (tool caliber =
  page caliber):
  - `get_public_category` view=`brand_leaderboard` now returns `categoryMentionCount` (the
    category-wide SoM denominator, computed before the row cap) and a per-row `som` — the
    percentage the page shows, without pairing the call with `view=overview` yourself. New
    `offset` (0–5000) pages past the 200-row cap; the order is `totalMentions DESC,
    brandName ASC, publicBrandId ASC` (the same key as `get_public_brand` view=`category_ranking`).
  - A **merged** category slug now returns `{ error:"slug merged", canonicalSlug }` instead of
    `null` (the web page 308-redirects there); empty results list `availablePlatforms` next to
    `availableLocales`, and every response echoes `platformUsed`. Paging past the last row
    (`offset` beyond the end) returns zero rows plus an `endOfList` marker — not the
    "wrong locale/platform" hints, which would send you to fix a parameter that is fine.
    Legacy platform aliases (`ai_overview` → `google_ai`) are normalised the same way across
    `get_public_category`, `get_category_whitespace`, `get_category_brand_momentum` and
    `get_public_data_window`, so one alias no longer works on one tool and silently returns
    nothing on its neighbours.
  - The `window` echo now carries a **per-view note**, **added to** (never replacing) the
    window-resolution note — so the "all-history aggregate", "this platform has no published
    batch yet, figures fall back to all history" and "the window crosses a collection-scale
    breakpoint" warnings always survive. Inside `view=overview` only `brandCount` /
    `mentionCount` follow the window — `topicCount` is inventory and `monthlyAiTraffic` /
    `monthlyRevenueUsd` are modeled monthly stocks, ChatGPT-calibrated only (0 on other
    platforms); when no window is in effect those two columns are labelled ALL-HISTORY instead
    of being claimed as windowed. `view=som_trend` **without an effective window** (`range=all`,
    or a platform with no published batch yet) says plainly that it returns the newest
    `max_points` (default 30) days ending at the category's latest record date, not all history.
  - `get_category_brand_momentum` defaults to `days=30` / `limit=8` (the report §06 caliber; the
    old 7/10 matched nothing on screen) and states that both windows are anchored on the
    **category's** latest `record_date`, not the published-batch anchor.
  - `get_category_whitespace` and `get_public_search_queries` mode=`territories` now echo
    `caliber {windowed:false}` and say so in their descriptions: both are **all-time** readers
    with no date predicate, so their shares and record counts must never be netted against
    windowed figures.
  - `get_topic_competition_difficulty` returns `window {days:28, to:asOfDate,
    anchor:'global-latest-record-date', platformScoped:false}` — a fixed 28-day, cross-platform
    caliber that does not move with `range` / `platform` / topic filters.
  - `get_public_data_window` with `product_space_id` adds `productSpace.reportWindow` — the
    printable category report's own anchor (that category's latest `record_date` for the
    platform+locale, back 30 days). Pass its `from`/`to` as `date_from`/`date_to` to
    `get_public_category` to reproduce the report exactly.
- **Shopping tools = page caliber** (parity audit 2026-09-22 §1.18, `/shopping` + `/product` +
  `/category` shelf):
  - `list_public_shopping_boards` resolves `country` / `language` / `platform` exactly like the
    /shopping page (unknown locale → US/en with `defaulted=true` + `availableLocales`; a
    platform with no shelf rows → chatgpt, or the first platform that does have rows when
    chatgpt has none either) and echoes `data.platformUsed` + `data.availablePlatforms`
    (platform **ids**; `get_available_platforms scope=shopping` returns the same set with
    `recordCount`) — before, FR/AIO requests returned the US/en/chatgpt board
    labelled FR/AIO. New `page` (0-based, × `limit`) walks each board down to its full 200
    depth like the page's "load more"; response adds `page`, `pageSize`, per-board `hasMore`.
    A deep page the server cannot serve now names that board in `pagingDegraded`
    (`unsigned` = the page was never signed, fail-closed; `rejected` = signature
    verification failed) instead of just coming back short.
    Description now states the real board rules: climbers = relative growth
    `appearances / appearancesPrev` with ≥20 / ≥10 thresholds, entrants = into the top-100
    from absent / outside, `comparable=false` also when the topic pool grew >2% (even with
    `prevBatchDate` set), hot candidates need ≥5 appearances.
  - `get_public_shopping_product_detail` follows a **merged** `product_id` to its survivor
    (page 308) in both modes — `resolvedProductId` / `mergedFrom` echoed; unknown id → `error`
    (was "no data, widen days"). `mode=full` adds `platformUsed` + `availablePlatforms
    [{platformId, records}]` (the page's switcher, 90 days up to `to`), also on the no-data
    error. The switcher lookup is auxiliary: when it fails or times out the analysis is still
    returned, with `availablePlatforms: null` + a `platformsNote` (null = "unknown this call",
    never "no platforms have data").
  - `get_available_platforms` gains `scope=shopping` (the /shopping switcher — platforms with
    shelf rows in a locale; global/category count answer records and can list a platform whose
    shelf is empty) and `scope=product` (`product_id` + optional `to`: the /product switcher
    with per-platform answer counts).
  - `search_public_entities` gains `platform` for the **products group only** (the /shopping
    page search caliber — appearances / latestSeen / productSpaceId for that platform; default
    stays cross-platform) and echoes `productsPlatform`; `limit` now goes to 30 for products
    (entity groups still clamp at 20).
  - `list_public_shopping_products` gains `channel_domain` (the page's channel drill-down:
    ≤12 products routed through that retailer this batch, rank back-filled), returns
    `searchNote` when `search` is shorter than 2 chars instead of silently returning the
    ranking, and documents the card fields it always returned (`image` / `rating` / `reviews`
    come from the 30 days up to the batch day; the rest is strictly the batch).
  - Timeouts: both list tools now get a 50s budget on MCP and agent paths (the shelf ranking
    is bounded by the 45s public statement timeout like the boards), and **both paths now
    share one timeout message**. It states what actually happened — the statement was either
    **cancelled** server-side at 45s or **never started** (a caller's budget now covers the
    time spent queued for a DB slot, and a query whose budget runs out while queued is
    dropped from the queue instead of starting later with nobody waiting for it), so nothing
    keeps running and nothing is cached, and an identical retry just times out again — and
    names only the inputs that really shrink the
    ranking query: `country`/`language`/`platform` for the boards, plus `topic_ids` for a
    category shelf. `board` / `limit` / `page` / `page_size` / `search` only slice a ranking
    that has already been computed, so they are explicitly called out as **not** cheaper.
  - Descriptions on `search_public_entities`, `get_public_topic_commerce` and the deprecated
    `get_public_shopping_card_detail` no longer point at the deprecated alias; they name
    `get_public_shopping_product_detail(mode="card")`.
- **Record family catches up with the answer dialog** (`docs/mcp/TOOL_PAGE_PARITY_AUDIT_2026-09-22.md`,
  record-family batch). Every record-carrying row (`get_prompt_record_detail`, `list_prompt_records`,
  `get_prompt_record_summaries`, `get_brand_mention_samples`, `list_brand_answers`, raw
  `get_prompt_citations`) now carries **`businessDay`** — the UTC+8 business day `YYYY-MM-DD` the
  app displays; `recordDate` stays the stored `(D−1)T16:00Z` timestamp. `list_brand_answers.window`
  echoes `startBusinessDay` / `endBusinessDay` — the first / last business day the window
  actually covers (`endBusinessDay` `null` = up to now); on a rolling window `startBusinessDay`
  is rounded up to the first matchable day, not `start`'s calendar date.
- **`get_prompt_record_detail`** gains the dialog's derived fields: `webSearchStatus`
  (`searched | not_searched | unknown`, resolved from citations + search sources + echo-free
  queries + flag + `aiModel` — the raw `webSearchTriggered` is not reliable alone),
  `realtimeQueries` (prompt echoes dropped, de-duplicated), `displayed.{sentiment, mentionRank}`
  (the status-bar gates: completed ∧ mentions > 0; rank additionally needs another named brand
  entity ∧ rank > 0), `promptText`, and `citationTotal` / `searchSourceTotal` / `shoppingTotal` +
  `*Truncated` flags next to the capped `citations` (30) / `searchSources` (30) / `shopping` (20).
  Those three fields are now always arrays (they used to be passed through unchanged on the
  never-observed non-array case).
- **`get_prompt_citations` explicit dates are UTC+8 calendar days** (Beijing 00:00 → 23:59:59.999,
  the `/prompts/[id]` page boundary; was UTC midnight, so old pulls with `start_date` / `end_date`
  shift by 8h). Spans up to 366 days stay accepted. Raw rows add `businessDay`.
- **Platform gate on the record family**: `get_prompt_citations`, `list_prompt_records` and
  `get_brand_mention_samples` now return an error object for an unknown or un-entitled platform
  code (the page fail-closes to an empty state) instead of silently reading un-entitled history
  (`get_prompt_citations`) or returning an empty list / sample. `copilot` is a valid code.
- **`list_prompt_records.shoppingVisible` caliber corrected**: ChatGPT = upstream flag; Google AI
  Mode = derived from captured shelf cards (true or null, never false); null elsewhere. It is a
  per-answer flag — the `/performance/shopping` denominator is "answers with ≥ 1 captured shelf
  card", which can differ. The old "skip shoppingVisible=false" advice is withdrawn.
- **`get_brand_search_queries` mode=`prompt_queries`** now rejects a `prompt_id` that is not this
  brand's with `Prompt … not found for this brand.` (was an empty `recordsWithQueries=0` shell).
- **Audit tools read what the /audit/[id] report shows** (page-parity audit 2026-09-22, audit-1…7).
  `get_audit_detail` now assembles the page's three read models: the report header
  (`headline {fail, warn, pass}`, `dimensionScores[]` for the D1 / D2 / D3 / D8 rings — computed
  with the page's own formula per mode, from the FULL issue buckets), `citationInsights` (the
  "AI citation insights" banner, rolling 30 days — **opt-in**, see the next entry), and — for **single**-URL audits — `checks[]` +
  `page` parsed from the audited page (previously a single audit came back with
  `aggregatedIssues=null` and `criticalCount=0`, which reads as "no problems"). `checksMeta`
  maps check ids to their catalogue copy (every id of the full report, so in site mode also the
  ones past the per-bucket cap) (`problemTitle`,
  `problemDescription`, `howToFix`, `severity`, `effort`, `isQuickWin`). Descriptions now state
  the mode matrix (site: sub-score columns always null; single: the three counts are 0 = not
  computed) and the `status` enum / polling rule.
- **New: `get_audit_pages`** — a site audit's per-page results ("By page" tab): `fetchQuality` /
  `fetchIssues`, per-page `counts` and `checks[]`, filter by `page_type` / `fetch_quality`
  (`unusable` = the pages the report could not diagnose), paged 1–25.
- `get_audit_list` `page_size` cap 50 → 100 (the page offers 10 / 25 / 50 / 100).
- `get_audit_detail`'s `citationInsights` banner is **opt-in**: pass `include_citation_insights=true`.
  It is a whole-history scan of this brand's citations of the audited domain, so leaving it off keeps the
  call a point read (you get `{unavailable: true, reason: "not_requested"}`); when asked for, the result is
  cached for an hour per brand + domain + day, so a retry does not re-run it. Besides `"timeout"` /
  `"error"`, `reason` can now be `"budget"` (the rest of the report left no time to start the scan) —
  none of those mean "zero citations". For per-domain citation counts `get_domain_detail` is the cheap read.
- **Topic tools catch up with `/topic/[slug]`** (tool caliber = page caliber, audit §1.15):
  `get_public_topic_prompt_detail` gains `include_fanout=true` → the page sheet's "Query fan-out"
  block (`fanout {recordsWithQueries, expansionQueries[≤100 with brand chips + intents],
  echoQueryCount}`, chatgpt-only, best-effort: `null` when that lookup fails), and its description
  now states the caliber it always had — **ALL-HISTORY, not windowed**, so its brand shares do not
  reconcile with the windowed prompt list / matrix / leaderboard.
  `get_public_topic_record_detail` stops dropping what the page's record sheet renders: `scope`
  (pass `scope.productSpaceId` with a `shoppingItems[].productId` to
  `get_public_shopping_product_detail mode="card"`), `serp` (google_ai_overview records only —
  organic / PAA / related searches, 10 each), `shoppingItems[].productId` and
  `citations[].markerPositions` (the inline `[N]` footnotes), plus `include_answer_text=true`
  for the full answer body — `_truncated.answerSnippet` is now true only when the body was really
  cut, with `_truncated.answerChars` next to it. (Still not returned, as before: `citations[].lookupUrl`
  / `sourceType` and `searchSources[].snippet`.)
  `get_public_topic_overview` returns `kpi.aiTrafficMonthly` (+ `aiTrafficSource`) = the page's
  AI-traffic KPI chain (effective → default → mid), and says out loud that `records.*` /
  `brands.mentions` are counted on `latestCompletedRecordDate` only — one batch day, not a window.
  `get_public_topic_commerce` returns `revenueEstimate` = the page's modeled "AI revenue" KPI
  (traffic × inverse-priced CVR × median-price AOV, raw/unrounded; `isPlaceholder` when no price was
  collected; `null` when there is no modeled traffic, or when that auxiliary traffic read is
  unavailable — it never blocks the commerce aggregates themselves).
  `get_public_topic_prompt_matrix` adds `brands[].shareAmongColumns` (same number as the
  misleading `shareOfMention`, which stays one release): it is the share of the top-N COLUMNS,
  not the leaderboard SoM — units are now spelled out (columns fraction, cells percentage).
  `get_public_topic_brand_leaderboard` echoes the resolved `platform` (the legacy `platformId`
  only echoes the deprecated `platform_id` input). `get_public_topic_citation_domains`'
  description now matches the fields it actually returns (no per-domain cited-rate; plus
  `concentration` over ALL domains and `topUrls`).

## 0.5.3

- **`get_competitor_list` is a paged envelope** — `{ rows[], total, page, page_size, total_pages,
  counts {tracked, suggested, removed}, names_mode }` instead of one flat array. A user report:
  53 entities × up to 200 spellings each blew through the 60k output cap and the generic
  truncation left 3 rows with no way to fetch the rest. New parameters: `status`
  (all / tracked / suggested / removed), `search` (name, root domain or any spelling),
  `entity_id`, `names` (`summary` default = user-added + up to 12 learned spellings; `full`;
  `none`), `names_offset`, `page` / `page_size` (default 50, max 200). Every row now carries
  `names_total` and `names_truncated`; `entity_id` + `names="full"` returns one entity's
  complete alias list 500 at a time (`names_next_offset` → `names_offset`; the page itself
  folds at 200).
- Truncation messages (`_message` on `_truncated` results) now name **that tool's** narrowing
  parameters instead of the old fixed "time_range, platform, domain" text, which most tools
  do not have.

## 0.5.2

Consolidates the 2026-09-20/21 tool-surface overhaul (geoly-app #1817 + #1796, 15 PRs). Rule of
the cycle: **tool caliber = page caliber** — every tool below reads the same read model as the
in-app page it mirrors, and the new ones are exits of pages that had no tool before.

- **New — start here:** `get_brand_context` (free, resident): brand, org, today's three date axes,
  platforms with data, topics, competitors, data window and remaining credits in one call —
  replaces the `get_current_date` + `get_competitor_list` + `get_available_platforms` opening.
  `get_topic_list` (free) is back on the read-only surface: the source of topic ids.
  `get_public_data_window` (free): the "as of" anchor for every public tool.
- **New reads:** `get_brand_board` (the /performance board on the **entity** caliber,
  `caliber=brand_entity_v1`; `status=not-ready` / `no-coverage` are states, not empty data);
  `list_brand_answers` (the /performance/answers table — every answer, filtered and paginated).
  `query_analytics` gains `compare_previous=true` (previous window + `delta` per metric, with
  `days_with_data`).
- **New writes** (consent Write grant on `prompt`): `archive_prompt` (restore with
  `restore=true`; archived prompts refuse `trigger_prompt`), `update_prompt_tags`
  (`add` / `remove` / `rename`), `move_prompts_to_topic` (`topic_id=null` ungroups). Read archived
  prompts with `get_prompt_list status=archived`. `geoly call` asks `[y/N]` or takes `--yes`
  (CLI ≥ 0.3.1).
- **Deprecated, still registered, same response and price** (forwarding aliases; do not start
  new work on them): `get_competitor_overview` → `get_platform_matrix dimension=competitor`;
  `get_brand_citations_daily` → `query_analytics dataset=brand_citations_daily`;
  `get_ga4_page_data` → `get_ga4_traffic_data page_path`;
  `get_public_brand_perception_aspect_mentions` → `get_public_brand_perception mode=aspect_mentions`;
  `get_public_search_query_detail` → `get_public_search_queries mode=query_detail|theme_detail`;
  `get_public_shopping_card_detail` → `get_public_shopping_product_detail mode=card`. Four
  `get_public_search_queries` modes and four `get_public_brand` / `compare_public_brands` views
  are retired with a `_deprecated` notice (catalog § Deprecated). `geoly tools --json` flags them.
- **Caliber changes you will notice in numbers:** `get_citation_overview` / `get_domain_detail` /
  `get_page_detail` moved to the /sources/citations page window (N whole Asia/Shanghai days on the
  citation-creation axis plus today; `caliber` + `window` in every response; `legacy` = derived
  layer unavailable). `get_competitor_list` is the Settings › Brand library (entity layer).
  `get_sentiment_dashboard` slimmed to distribution / trend / per-platform. Windowed public tools
  default to the latest published 30d batch window (was: all history) and echo `window`.
  Details and the "never mix these two" pairs: `references/metric-calibers.md`.
- **Faster, same numbers:** KPI sides of `query_analytics`, `get_topic_analytics`,
  `get_platform_matrix(topic)`, `get_sentiment_dashboard`, `get_brand_context` and the three
  citation tools read the pre-aggregated daily layer (T2 / T1-C) when it is ready and fall back
  to the live query otherwise — a `tool_error` timeout on a large brand is now the exception.
  `query_analytics` without `citationCount` no longer runs the citation-side query at all.

## 0.5.1

- **Routing first.** New opening section "which door are you at?": with the `geoly` CLI on PATH,
  an agent hands the question to `geoly run` instead of rebuilding it from `geoly tools` /
  `schema` / `call` chains (a headless Claude Code run did exactly that — 15 turns, three timeouts,
  no answer — because the CLI section was labelled "optional, for loops/exports"). MCP tools are
  the path only when they are mounted and there is no CLI; the MCP pre-flight is marked MCP-only.
- CLI section rewritten in that order: `run` (default) → `call` (specific pulls / loops) →
  bootstrap. `--help` named as the flag reference; `tool_error` on heavy tools = use `run`, not retry.
- Frontmatter description now names the CLI so the skill triggers for CLI users.
- Two branches the routing left open: a CLI older than 0.3.0 (no `run`) → `geoly upgrade` first,
  and if that cannot happen, stay on the CLI in its older `tools` / `schema` / `call` shape rather
  than falling into the MCP pre-flight. Bootstrap is now decided by shell-vs-browser: a shell
  without a browser (SSH, container, CI) still bootstraps via `auth login --remote` /
  `GEOLY_TOKEN`; only hosts with no shell at all skip it for the MCP pre-flight.
- Door 1 also covers a CLI that is on PATH but not signed in (exit code 3): the CLI signs in
  lazily by itself — browser when there is one, printed URL + `auth login --code` when there is
  not, `GEOLY_TOKEN` under `CI=true` — so an agent re-runs the command instead of switching doors.

## 0.5.0

- *(2026-09-20, server-side caliber change — no skill version bump)* **Competitor tools re-read
  from the in-app pages:** `get_competitor_polarity` now returns the AI Verdict page's "who beats you"
  board (`brand_mention_vote.stance = preferred`, top 5, ≥3 answers, votes since 2026-09-08) —
  `tie` / `weWin` / `netLoss` / `coMentions` / `totalNetLosing` are gone; same parameters as before. `get_risk_context_sources`
  now returns the Verdict page's Sources tab (`kind`, `citedRecords`, `negativeShare` from own-entity
  negative aspect votes, `topAspects`, `delta`) and **gains parameters** — `time_range` (7d default =
  the old fixed window, 30d, custom), `start_date`, `end_date`, `platform` (all optional; a call with
  no arguments still targets the last 7 days on all entitled platforms) — instead of the fixed 7-day, all-platform window; `lift` is gone.
  `get_competitor_cooccurrence` keeps its parameters; its competitors come from the
  brand-entity layer (folded names, `stance`, `mentions`) instead of the legacy
  `prompt_record.competitors` JSON.
- **`get_competitor_overview` deprecated** → `get_platform_matrix` (`dimension=competitor`); still
  registered, **its response shape and its price are unchanged** (`brand` + `competitors[]`,
  same credits as before), so existing callers keep working — only the description and the
  hosted agent's resident set changed. Catalog moves it to a "Deprecated" section;
  `metric-calibers.md` explains why matrix competitor counts can be lower than LLM-judged rows
  (`count_state = counted` only).

- **CLI `geoly run` (CLI ≥ 0.3.0):** delegate a whole question to GEOly's hosted GEO agent
  (`/api/agent/runs`) from the terminal — one JSON receipt (`status`, `run_id`, `answer`,
  credits, `saved_to`), `running` hand-off with `geoly runs wait <id>` so agent shells don't time
  out, `--spec` deliverables, `--max-credits`. Retries of the same command are idempotent for
  10 minutes (server `Idempotency-Key`), so a timed-out shell never double-charges.
- **Remote sign-in:** `geoly auth login --remote` + `--code` for machines without a local
  browser (SSH / containers). Servers and CI keep using `GEOLY_TOKEN`.
- **`geoly credits`:** both credit pools at a glance.
- Exit code 7 (credits exhausted) documented; `--help` named as the authoritative flag reference.
- Housekeeping: the published skill bundle (`/skills/geoly-mcp.zip`) is now regenerated on every
  app build, and a test pins registered MCP tools ⊆ rate table ⊆ this catalog.

## 0.4.2

- **Two new brand-own tools from the AI Verdict view (custom monitoring, `/performance/verdict`).**
  `get_competitor_polarity`: per-answer preference polarity vs each competitor mentioned in the
  brand's answers (`coMentions` = judged records, not "both named"; brand need not be named) —
  `weLose` / `tie` / `weWin`, `netLoss`, `netLossRate`; polarity, not visibility (pair with
  `get_competitor_overview`). `get_risk_context_sources`: cited domains over-represented in
  negative / mixed answers, with empirical-Bayes-shrunk `lift`; window fixed at 7 days;
  co-occurrence, not causation. Both are own-monitoring data (free, nominal-price observed).
- **Catalog gap closed:** `get_brand_search_queries` (query-fanout demand roots, ChatGPT only)
  was live on MCP but missing from the catalog; documented under group C.
- **Catalog corrected against the code:** `get_quota` (always registered) and
  `resolve_page_context` (desktop page awareness) were live on MCP but never listed; both added
  under group A. `get_discovered_links` footnote fixed — it is *excluded*, not "inert".
  Read-only count 33 → 35; max surface 70 → 72.

## 0.4.1

- **New public tool `get_public_brand_rank_citation` (Google AI Overview only).** Rankings ×
  AI Citations cross-view: does organic top-10 ranking convert into an AI Overview citation?
  `mode=board` returns coverage, four search-counting quadrants (count/prevCount) and displacer
  domains with a competitor heuristic; `mode=rows` returns paginated per-search detail with
  per-round stability (null = no valid observation) and `snapshot_key` consistency pinning.
  Public tool count 27 → 28.

## 0.3.2

- Classify MCP setup, organization, subscription, and organization-selection errors before
  attempting OAuth again. Only genuine `AUTH_REQUIRED`/401 states trigger
  `codex mcp login geoly`, preventing entitlement and onboarding failures from becoming
  reauthorization loops.

## 0.3.1

- **Platform lineup refresh: Grok retired.** The engine roster is now ChatGPT, Perplexity,
  Google AI Mode (`google_ai`), Google AI Overview (`google_ai_overview`), Gemini — with
  Copilot onboarding next. All platform-filter enums across the brand tools now read
  `chatgpt, gemini, perplexity, google_ai, google_ai_overview` (passing `grok` returns
  nothing — it stopped collecting). As always, discover per-scope platforms with
  `get_available_platforms` instead of assuming.
- **Tool surface 66 → 67: `list_prompt_records`.** Full execution history of one prompt over a
  time range, paginated (unlike `get_prompt_record_summaries`, which returns only the latest
  record per platform). Rows carry `shoppingVisible` for shopping-card trend work; feed a row
  `id` to `get_prompt_record_detail`. Explicit `start_date`/`end_date` are **UTC+8 business
  days** and must be paired (they override `time_range`).
- **Competitor caliber change (2026-07-24, metric-calibers §7).**
  `get_competitor_overview` / `get_platform_matrix` `somShare` is now records-based Share of
  Mentions (once per answer ÷ all brand-mentioned records, +`mentionedRecords` field), and
  their roster is **automatically discovered** competitors — no longer the user-tracked list
  (`get_competitor_list` keeps returning the tracked list). `get_topic_analytics` top
  competitors likewise auto-discovered. Old pulls will not reconcile. The SoM glossary row is
  now split into prompt-level (visibility-based) vs cross-prompt (records-based) calibers.

## 0.3.0

- **Tool surface 63 → 66: three new tools.** `list_public_shopping_boards` (the cross-category
  AI shelf leaderboard — hot/climbers/entrants with batch-vs-batch rank moves),
  `get_public_shopping_product_detail` (one product's full AI analysis: shelves, weekly trend,
  rivals, channels), and `get_public_source_brand_conduit` (the topics where a source domain
  funnels AI attention toward a brand; available to every token, no plan gate).
- **New facets & params.** `get_public_search_queries` gains `mode=territories` (demand-root
  ownership map; counts only `web_search_query` rewrites). `get_public_source_domain_detail`
  gains `include_scorecard` (full AI DA breakdown: authority/placement/breadth sub-scores,
  rank + pool, momentum, confidence, integrity) — `totalAppearances`/`usableRate` are now
  deprecated and always null, and `coOccurringBrands` documents its ≥10-per-topic threshold.
  `search_public_entities` gains `include_products` (+ `country`/`language` for
  `productSpaceId` resolution) and now also returns citation source domains.
- **Multi-org gating flipped.** Public tools are now enabled on multi-org connections when ANY
  accessible org is Grow-tier+ (they were single-org-only in v1); writes on multi-org stay
  clamped read-only. Consent is a per-resource read/write grid (default all-read, no-write).
- **Caliber corrections (2026-07-23) — old pulls will not match; new metric-calibers §7.**
  `get_brand_citations_daily.citationCount` fixed from always-0 to real values;
  `get_competitor_overview.brand.mentionRate` fixed from a density (could exceed 100) to a true
  rate; `get_prompt_list` no longer carries the placeholder `geoMetrics.som`; public AI-search
  query tools exclude echo rewrites everywhere.
- **Leaner big payloads.** `get_public_brand view=competitors` returns W/L/T totals without
  per-topic battle cells over MCP; over-cap public/report responses now degrade to a parseable
  JSON envelope (`_truncated`/`preview`) instead of a hard-sliced invalid JSON string.

## 0.2.1

- **New `list_public_topic_prompts` tool — enumerate EVERY prompt under a topic.**
  Fixes a real reconciliation gap: `get_public_topic_prompt_matrix` only emits prompt rows
  that cover the top-N brands, so a prompt whose only mentions fall outside those columns
  (e.g. led by a niche brand ranked #15) was silently absent — the matrix could return 8
  rows for a 9-prompt topic. The new tool lists all active prompts (not brand-filtered),
  sorted by total mentions, each with intent + total mentions + leader brand & share. Use it
  for the complete prompt list, to reconcile a topic prompt count, or to get a `prompt_id`
  for `get_public_topic_prompt_detail`.
- **Clearer `get_public_topic_prompt_matrix` description.** It now states up front that rows
  are limited to prompts covering the top-N brands and points to `list_public_topic_prompts`
  for full enumeration, so agents stop mistaking the matrix for a prompt enumerator.

## 0.2.0

- **GEOly CLI section (agent bootstrap).** The tool surface now has a terminal projection
  ([geoly-ai/GEOly-Cli](https://github.com/geoly-ai/GEOly-Cli)) built for agents. New SKILL.md
  section teaches: when to prefer the CLI over MCP calls (loops / large exports / CI), the
  zero-interaction install commands (curl / Windows PowerShell irm, with GitHub mirror), lazy
  auth semantics (no login step — first `geoly call` opens the browser; slow return is normal;
  `GEOLY_TOKEN` for CI), the probe-first usage pattern (`geoly tools --json` → `geoly schema`
  → `geoly call`), stable exit codes, and the Windows env-var gotcha.

## 0.1.5

- **Platform dimension across the public tools.** Public facts are sliced by AI platform
  (`chatgpt`, `google_ai`, …). 18 public tools gained an optional `platform` param (default
  `chatgpt`); `get_public_topic_brand_leaderboard` now takes canonical `platform` with
  `platform_id` kept as a deprecated alias. A new **`get_available_platforms`** discovery tool
  returns which platforms actually have data for a scope (brand / topic / category / global),
  so the agent discovers before passing `platform` and avoids ChatGPT-only under-reporting once
  Google AI Mode data lands. `references/public-tools.md` (now 24 tools) adds a Platform
  convention section + a defaulting caveat; `references/tools-catalog.md` and `SKILL.md` bump
  the max surface to 62. Tools with no meaningful platform slice are intentionally excluded
  (`search_public_entities`, `list_public_locales`, `get_topic_competition_difficulty`,
  `get_public_topic_record_detail`).

## 0.1.4

- `SKILL.md`: turn the "tools not available" note into a **pre-flight auto-authorize** flow. When
  the GEOly MCP tools are missing (server registered but showing an *Authenticate / 进行身份验证*
  button), the agent now proactively runs `codex mcp login geoly` to open the OAuth sign-in window
  for the user — instead of telling them to hunt for the button — falling back to the
  *Settings → MCP servers* button only when the shell is unavailable. It then guides the full
  restart that mounts the tools, and notes the Codex Desktop case where tools may authenticate but
  not import (use the CLI). Covers both causes (never authenticated / session started pre-auth).
  The browser sign-in itself is still completed by the user once — credentials aren't auto-entered —
  and existing installs only pick this up after the 3-step plugin upgrade and a full restart.

## 0.1.3

- `.mcp.json`: tag the remote MCP connection with `http_headers`
  (`X-Client-Name: geoly-codex-plugin`, `X-Client-Version`) so server-side logs can
  attribute traffic to the Codex plugin. Counting must be **deduplicated by user/org**,
  never by raw request — see `docs/mcp/CODEX_PLUGIN_DISTRIBUTION.md`.

## 0.1.2

- `SKILL.md`: add a once-per-session, non-blocking **version check** — the agent compares its
  installed `metadata.version` against the latest published `version` (raw `plugin.json` on the
  repo) and nudges the user to upgrade if behind. Best-effort; skips silently if unreachable.

## 0.1.1

- `SKILL.md`: add a "tools not available in this session" note — when the skill is loaded but
  the GEOly MCP tools are not mounted, tell the user to fully restart their MCP client / open a
  new session (tools load at client startup; a raw call without the OAuth token is a red-herring
  401). Avoids the agent flailing with manual HTTP probes.
- Brand display rebranded Geoly → GEOly; `SKILL.md` links the brand to https://www.geoly.ai.

## 0.1.0

- Initial release. Mirrors the skills.sh / Anthropic Agent Skills layout
  (`SKILL.md` + `references/` + `CHANGELOG.md`).
- `SKILL.md`: Core Principles (KPI baseline, daily-average trap, monitoring gaps,
  caliber verification, brand resolution, error recovery), connection & access model
  (mode-based discovery, 402 gating, Grow-tier public tools, write profiles),
  question→tool selection for both surfaces, recipes, and Reference Guides index.
- `references/metric-calibers.md`: metric glossary, the citationRate three-caliber trap,
  data-shape pitfalls, hard limits, reconciliation cheat-sheet.
- `references/tools-catalog.md`: full catalog of registered MCP tools (up to 61), grouped,
  with parameters; plus the in-app-only tools that are NOT on MCP.
- `references/public-tools.md`: 23 public / industry competitive-intelligence tools,
  locale convention, and a question→tool-chain playbook.
- All tool names, parameters, calibers, limits, and gating verified against the codebase.
