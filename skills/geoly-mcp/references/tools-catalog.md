# GEOly MCP — full tool catalog (up to 80 tools)

_Use this when you need a tool's exact parameters/enums/defaults, or to confirm whether a tool is exposed over MCP._

Ground-truth catalog of the tools the GEOly MCP server **registers**. This is the MCP surface
— several internal agent tools exist in the codebase but are NOT exposed over MCP (see
§ Not on MCP). Availability depends on **mode** and **plan**:

- **Discovery selectors** (`list_organizations`, `list_brands`) appear only in multi-brand /
  multi-org mode.
- **Write tools** require write access granted on the OAuth consent screen (per-resource
  read/write grid; legacy `?tool_profile=standard` still honored); read-only by default, and
  multi-org connections are **always** read-only (write grants clamped).
- **Public tools** require a Grow-tier-or-above plan; multi-org connections get them when
  **any** accessible org qualifies.
- Brand-scoped tools auto-resolve the brand when the org has one brand or the token is
  brand-bound; otherwise pass `brand_id` (discover it via `list_brands`).

Parameter notation: `name: type (constraints, default)`. `time_range` is the shared enum
`7d | 30d | 90d` (default `30d`) **unless the row says otherwise**.

---

## A. Discovery & routing (6)

| Tool | Purpose | Params |
|---|---|---|
| `list_organizations` | List org IDs the token can access (multi-org mode only) | — |
| `list_brands` | List brand IDs in the org (multi-brand / multi-org only) | `org_id` (optional, multi-org only) |
| `get_brand_context` | **Call first, once per run (free).** One-shot orientation: `brand` (id, name, domain, website), `organization` (id, name, plan, subscription_status), `today` (`utc_date`, `business_date` in Asia/Shanghai, `record_date_key` — the date-axis value today's records land under, one day behind the business day), `platforms` (only those with completed records in the last 30 days: code, name, `last_record_date`, `completed_records_30d`), `topics` (id, name, promptCount), `competitors` (tracked list), `data_window` (first/last record_date), `credits` (remaining AI / MCP). After it, do not call `get_current_date`, `get_competitor_list` or `get_available_platforms` again in the same run. No KPI numbers — those stay in `get_brand_overview` | — |
| `get_current_date` | Server time, for date-range validation (superseded by `get_brand_context.today` in normal runs) | — |
| `get_quota` | Quota status for the token's org(s): monthly MCP credits used / remaining, period reset date, enforcement mode. Always registered | — |
| `resolve_page_context` | Desktop client page awareness: resolve the GEOly web-app URL the user is viewing into an entity scope — pageKind, entity id + title, effective params, suggested tools | `url` |

---

## B. Brand-own — overview & KPI (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_brand_overview` | **KPI headline**: AIGVR score + mention/citation rates + per-platform stats | `time_range` |
| `query_analytics` | Controlled aggregation (no SQL) over daily datasets — also the **daily trend** tool (dataset `brand_citations_daily`: aigvr / mentionRate / citationRate per day per platform with the `completedRecords` denominator; `citationCount` = raw citation URLs that day — a **different numerator** from `citationRate`, never divide one by the other) | see **§ query_analytics** below |
| `resolve_my_brand_public` | Bridge: resolve this monitored brand → its `public_brand`. `bestMatch` is the **same decision the in-app /performance industry-profile card makes** (domain root authoritative → exact normalized name / match terms → alias; single active data-bearing entity only) and carries `availableLocales`; `matched ⇔ bestMatch !== null`; `ambiguous=true` = several active public brands collide (fail-closed, `bestMatch=null`). `candidates` (≤5, `matchedBy: link\|domain\|name\|alias` — heuristic rows are link/domain/name; when matched `candidates[0]` is `bestMatch` with its own domain/name/alias) is a heuristic context list — never substitute `candidates[0]` for a null `bestMatch` | — |

### query_analytics
- `dataset`: `brand_citations_daily | topic_citations_daily | topic_domain_citations_daily`
- `start_date, end_date` (YYYY-MM-DD; range ≤ 366 days)
- `dimensions[]`: `date | platform | platformName | topicId | topicName | domain` (`platformName` = display name, pairs with `platform`)
- `metrics[]`: `citationCount | citedRecords | mentionCount | mentionedRecords | completedRecords | brandCitationRecords | aigvr | mentionRate | citationRate | recordCitationRate | sentiment.*` (`sentiment.positive/neutral/negative/mixed/unknown/scoredRecords/avgScore`)
- `platform`, `topic_id`, `topic_name`, `domain` (filters)
- `prompt_text_include`, `prompt_text_exclude` — **`topic_citations_daily` only**; define a prompt subset by text (live today)
- `limit`: 1–1000
- `compare_previous` (bool, default false): also runs the identical query over the equal-length window immediately before `start_date`; every row gains `previous.<metric>` and `delta.<metric>` (current − previous; rates are percentages, so the delta is in percentage points), and the response carries `window.{current,previous}.{start,end,days,days_with_data}` — read `days_with_data` before quoting a delta (a 7-day window with 6 collection days is not like-for-like). Rows with the `date` dimension are aligned by position (day i vs day i); `previous.date` shows the day actually compared. Price unchanged (per call).
- Returns `{ rows[], totalRows, _ref }` — `_ref` is for the in-app agent's display tools; MCP
  callers receive plain JSON and do not get a usable `_ref` (display tools aren't on MCP).
- **Daily trend recipe** (what `get_brand_citations_daily` used to return): `dataset=brand_citations_daily`,
  `dimensions=["date","platform"]` (add `"platformName"` for display names), `metrics=[citationCount,
  mentionCount, mentionedRecords, completedRecords, brandCitationRecords, aigvr, mentionRate,
  citationRate, sentiment.*]`. A row exists only for (date, platform) pairs with completed
  monitoring records — a missing day means no monitoring ran, not 0.

---

## C. Brand-own — prompts (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_prompt_list` | Search/list prompts with the **same read model and calibers as the `/prompts` table** (2026-09-20). Returns `{ prompts[], summary, totalRows, totalPages, currentPage, pageSize, competitorsIncluded }`. Per row: `geoMetrics.aigvr.{score, mentionRate (= ranked/completed), citationRate (= brand-cited/completed, headline caliber), rankedCount, totalCount}`, `delta.{visibility, position, citationRate}`, `platformRecords`, `performance`. `summary` = the bar above the table (whole filtered set, record-weighted `visibility` / `mentionRate` / `citationRate` + `*Delta` vs the previous equal window). **Competitors / SoM are opt-in**: default `include_competitors=false` (the page's first screen) → rows carry `competitorsDeferred: true` and have **no** `som` / `competitorMentions` / `delta.share`; `include_competitors=true` → real per-prompt Share of Mentions (`som.{share, rank, totalCompetitors}`, top-5 `competitorMentions` with `share`) — slower. `status` picks the page tab (`active` default / `archived`; no "all"). Truncation: `prompts` is **always an array**; if the page was cut, top-level `_truncated` / `_totalCount` (rows on this page before the cut) / `_shownCount` / `_message`. `citationsCount` (citation URLs in window) is tool-only | `page, page_size (1–100), search, sort_by: text\|visibility\|position\|citations\|date, sort_order: asc\|desc, time_range, start_date, end_date, platform, tags[], topic[], topic_name, status: active\|archived, country, include_competitors (bool, default false)` |
| `get_prompt_detail` | One prompt with the **same read model as `/prompts/[id]`** (2026-09-20): **windowed** (default 30d; `custom` clamped to 90d) and platform-scoped (unknown / un-entitled platform → error object). Returns `{ prompt, window, overview, sourceDomains }`: `overview.{totalRecords, mentionedRecords (position IS NOT NULL), mentionRate, brandVisibilityScore (per-day AIGVR averaged over days — overview caliber, ≠ the record-weighted list-row score), brandShare (Share of Mentions vs entity-layer competitors), topCompetitor, discoveredCompetitorCount, benchmarkCompetitors (top 4), visibilityBoard[], benchmarkTrend[] (per day), platformMatrix (≥ 2 platforms only)}`; `sourceDomains.{rows (top root domains), totalDomainCount, breakdown {total, brand, competitor}, ownDomains}`. `include_lifetime=true` adds the **deprecated** old payload under `lifetime` (all-time, all-platform `recordsCount / citationsCount / geoMetrics / platformRecords`; removal scheduled) | `prompt_id, time_range: 7d\|30d\|custom, start_date, end_date, platform (default all), include_lifetime (bool, default false)` |
| `get_prompt_record_summaries` | **Latest** monitoring record per platform for one prompt (one row per platform, no history) | `prompt_id` |
| `list_prompt_records` | **Full execution history** of one prompt over a time range, paginated — every daily record, not just the latest. Each row: `id, platformCode/Name, recordDate, status, position, mentionRank, mentions, sentiment, sentimentScore, shoppingVisible`. Feed a returned `id` to `get_prompt_record_detail`. Use for per-day trend analysis (e.g. 30-day shopping-card presence): list here, then pull detail only for the records you need (skip `shoppingVisible=false` for shopping-card work) | `prompt_id, platform, time_range (7d\|30d\|90d, default 30d), start_date, end_date (explicit dates = UTC+8 business days, must be paired; they override time_range), limit (1–200, default 100), offset, sort_order: asc\|desc` |
| `list_brand_answers` | **Brand-level answers table** (= in-app `/performance/answers`): every completed AI answer for the brand in the window across ALL prompts, newest first, paginated. Filters: `platform`, `topic_ids`, `tags` (tag **names**; `_none` = untagged), `country` (ISO2), `entity_id` (answers mentioning one brand entity), `only_mentioned`. Row: `recordId, promptId, promptText, platformCode/Name, recordDate, country, brandMentioned, mentions, answerSummary, entities[] {entityId, displayName, isOwnBrand, domain}, entityTotal, sources[] (root domains), sourceTotal, citationCount, features {web, shopping, map, aiOverview}`. `total` computed on page 1 only; `hasMore` is the pagination truth; `status=filter_too_broad` = narrow the filter (fail-closed, never truncated). No position/sentiment column — drill with `get_prompt_record_detail` | `time_range (7d\|30d\|90d\|custom, default 30d), start_date, end_date (custom; UTC+8 business days, span ≤ 90d), platform, topic_ids[], tags[], country, entity_id, only_mentioned (bool), page (1–100), page_size (1–50, default 20)` |
| `get_prompt_record_detail` | Full detail of one monitoring record (answer, citations, sentiment, shopping cards). Brands named in the answer: read **`mentionedEntities`** (2026-09-20; entity layer, same as the answer dialog): `[{ entityId, displayName, isOwnBrand, majorityRole, stance: preferred\|equal\|inferior\|we_absent\|null, stanceSource: vote\|prmb\|null, mentionCount, domain }]`, own brand first. `mentionedBrands` (legacy `prompt_record_mentioned_brand`, raw names, 5th value `neutral`) and `competitors` (legacy text column × user-configured competitors) are **deprecated** and can disagree with `mentionedEntities` | `record_id, include_answer_text (bool, default false)` |
| `get_prompt_citations` | Citation list for a prompt — raw or deduplicated URL list with `share%` | `prompt_id, deduplicate (bool), limit (1–500), offset, time_range, start_date, end_date, sort_order: asc\|desc, platform, domain` |
| `get_prompt_mention_rates` | Per-prompt mention rate, **ascending** — blind-spot discovery ("which queries never mention us"). Primary columns (2026-09-20, `/prompts` caliber): `rankedCount` (completed records with `position IS NOT NULL`) and `rankedRate` (= rankedCount / totalRecords, %) — rows sort by `rankedRate`. `mentionCount` / `mentionRate` (numerator `mentions > 0`, = `get_brand_overview.mentionedCount`) are **deprecated**; by definition mentionRate ≥ rankedRate (identical in current production data — a predicate alignment, not a number change), never mix them | `time_range, min_records (1–100), limit (1–100), only_active (bool)` |
| `get_brand_search_queries` | AI search queries (query fanout) for the brand: the real web searches ChatGPT / Perplexity issued while answering tracked prompts, scoped by time window (default 30 days) and optionally platform / topic. `mode=overview` KPI block + who AI verifies by name + which sites it scrapes; `groups` evidence table grouped by prompt; `query_detail` per-query drill-down; `prompt_queries` one prompt's queries **as on `/prompts/[id]`** (2026-09-20): follows `time_range` (default 30d) and `platform` (default `all` = every entitled platform; was a fixed 90-day ChatGPT-only window — reproduce old pulls with `time_range=custom` over 90 days + `platform=chatgpt`), adds `platformCodes[]` per query, `totalQueries`, `echoDistinctCount`, `roots[]` / `competitorRoots[]`. **Deprecated modes** (step 1 of retirement: still forwarded, each response carries `_deprecated`, removal scheduled): `roots` -> `overview`, `topic_roots` -> `groups`, and **`root_detail` -> `groups` with `root_key` used as a substring search over query text** (the old root drill returned every query containing the root, so a substring search is the closest match — an exact `query_detail` lookup would miss almost every legacy call) | `mode (overview, groups, query_detail, prompt_queries), time_range, start_date, end_date, platform, topic_id, normalized_query, prompt_id, page, query_search, type_filter, result_filter` |

| `get_topic_list` | The brand's monitored topics — `id`, `name`, `description`, `position`, `promptCount` (prompts still monitored). **This is where topic ids come from** for `get_topic_analytics.topic_ids`, `query_analytics.topic_id`, `get_prompt_list.topic`. Free | — |

> `get_brand_context.topics` also returns every topic's id / name / promptCount in one call.
> On the public surface use `list_public_topics` instead.

---

## D. Brand-own — citations, domains & pages (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_citation_overview` | Citation **domain distribution** + ownership breakdown across the brand (counts URLs, not records). **Since 2026-09-20 the window is N whole +08 calendar days on the citation-creation axis + today** (same caliber as the in-app /citations page); every response carries `caliber` (`created-day` / `legacy`) + `window` — quote them. Removed: `brandMentions`, `brandMentionRate`, `uniqueUrls`, `dailyTrend[].brandMentions/brandMentionRate/brandUniqueUrls`, `trend.brandMentions/domains` | `time_range, platform` |
| `get_domain_detail` | One domain's citation profile: trend, pages, prompts, platforms, regions. Same `caliber` + `window` contract as `get_citation_overview` (+08 calendar days on citation-creation axis + today). `is_subdomain=false` + a registrable root matches the whole root; `is_subdomain=true` or a non-root input matches that exact host | `domain, is_subdomain (bool), time_range, platform` |
| `get_page_detail` | One page URL's citation detail: trend, prompt distribution, text snippets. Same `caliber` + `window` contract as `get_citation_overview` | `url, time_range, platform` |
| `get_url_reference_detail` | A URL's references across **both** citations and search sources; arbitrary windows | `url, time_range: 7d\|30d (default 30d — no 90d), start_date, end_date, platform, prompt_id, limit_recent (1–100)` |
| `get_content_opportunities` | Content-gap analysis: prompts where a domain has low/no citations | `domain, time_range, platform` |

---

## E. Brand-own — competitors, topics, platform, sentiment (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_competitor_list` | The brand **library** — same rows as Settings › Brand › Brands (brand-entity layer, not the legacy competitor table). Flat array with `status: tracked\|suggested\|removed`; tracked rows include your own brand (`is_own_brand=true`). Competitors = `status="tracked" AND is_own_brand=false`. Fields: `entity_id`, `name`, `root_domain`, `mentions_30d` (rolling 30d, entity rollup), `names[] {name, user_added}`; legacy `id` (competitor row id, null unless user-added) / `domains` / `aliases` / `isActive` kept one release, mapped from the entity layer | — |
| `get_brand_board` | **Entity-caliber brand board** (`caliber=brand_entity_v1`, = in-app `/performance` board). No `topic_ids`/`country` → `mode=confirmed`: rows = **confirmed competitors** (manual + auto slots → terminal entities); `visibility` = answers mentioning the entity ÷ completed answers (pooled over covered days — **same formula for your brand**, returned in `ownBrand` with `share`, `rank`, `pending`); `share` = mentionedRecords ÷ (you + all confirmed competitors). With `topic_ids`/`country` → `mode=scoped_open_world`: rows = the exact entities mentioned inside that scope (ranked by `mentionedRecords`; `share` within the candidate set — the set is capped at the top 200 entities by `mentionedRecords` (same cap as the in-app filtered board), so when `candidateTruncated=true` the `share` values are upper bounds and `total` is the candidate-set size, not the number of entities in scope (narrow the scope for an exact share); `visibility` only when the all-platform scoped denominator is available — null under a platform filter, since the scoped row source ignores platform), **fail-closed** — `status=not-ready` when the derived layer is not ready, never a silently unfiltered board. `status=no-coverage` = entity counts not computed for the window yet (not "no mentions"). Not the discovered-brand caliber of `get_competitor_overview` — don't mix them | `time_range (7d\|30d\|90d\|180d\|custom, default 30d), start_date, end_date (custom; span ≤ 90d), platform, topic_ids[] (`_none` = untopic'd prompts), country (ISO2), limit (1–50, default 20)` |
| `get_competitor_cooccurrence` | Brand + competitor co-occurrence (brand mentioned AND ≥1 other brand entity in the same answer): per-record detail + summary; optional answer text. **Caliber (2026-09-20)**: competitors come from the brand-entity layer — the same read path as the `/performance/answers` "mentioned brands" column (`brand_entity_mention_shadow` counted rows folded to their entity + per-answer `stance` from `brand_mention_vote`; per-answer fallback to `prompt_record_mentioned_brand`), NOT the legacy `prompt_record.competitors` JSON. Each competitor: `entityId, name, mentions, stance (preferred\|equal\|inferior\|we_absent\|null), majorityRole`. The brand's own entity and channel-role entities (retailers, app stores, media) are dropped **only where the entity layer supplies a role** — answers that fell back to `prompt_record_mentioned_brand` carry no role, so channel names can appear there; those rows have `entityId` prefixed `prmb:`. Summary on the newest 2000 mentioned answers, plus `arm` (entity\|prmb) and `truncated` (row fuse hit → competitors left empty; report it, it is not "no competitors") | `time_range, platform, limit (1–100), include_answer (bool), answer_max_chars` |
| `get_competitor_polarity` | **Who beats you** — the AI Verdict (`/performance/verdict`) competitor board, same read model as the page (2026-09-20): per linked competitor entity, `weLose` = answers in the window where the model voted `stance = preferred` for that rival (`brand_mention_vote`, one vote per answer × entity, current analyzer generation, entities folded along redirect chains). Rows under 3 answers dropped; top 5 by `weLose`; `delta` / `isNew` vs the previous equal-length window. Votes exist only for answers analyzed **since 2026-09-08**. No `tie` / `weWin` / `netLoss` / `coMentions` any more (dropped with the page redesign). Returns `{ window {start,end,days,label} (business days), platform, minRecords, standings[{entityId,name,domain,weLose,delta,isNew}] }` — exactly these four top-level keys (an empty `standings[]` = nobody reached `minRecords`, not a failure; errors come back as `{ error }`). Polarity, **not** visibility — pair with `get_platform_matrix` | `time_range (7d, 30d, custom — custom requires start_date), start_date, end_date, platform (must be entitled; else error)` |
| `get_platform_matrix` | Comparison matrix: brand + **automatically discovered** competitors × platform (overall Top 5 by `metric` + the brand), or topics × platform. Cell `somShare` = records-based Share of Mentions WITHIN that platform column; cells also carry `mentionedRecords`. Competitor rows come from the brand-entity layer (`brand_entity_mention_shadow`, `count_state = counted` only — ambiguous surfaces without a confirming vote are **not** counted, see metric-calibers.md). This is the competitor visibility tool for new work (`get_competitor_overview` is deprecated — same query, legacy flat shape, see the Deprecated section) | `dimension: topic\|competitor (default competitor), time_range, platform, metric: aigvr\|som\|citation (default aigvr)` |
| `get_topic_analytics` | Per-topic analysis: sentiment, top **automatically discovered** competitors, response types, trends. Also the way to enumerate topics over MCP | `time_range: 7d\|30d\|90d\|180d\|all\|custom (default 30d; custom requires start_date), start_date, end_date, platform, topic_ids[], include_ungrouped (bool)` |
| `get_sentiment_dashboard` | Brand-wide sentiment over a rolling window: `overview` (positive / neutral / negative / mixed counts, `total` = every record that carries a sentiment value — normally their sum, can exceed it if an unrecognised value ever appears, `avgScore` −1..1), `trend` (per UTC+8 business day, gaps = no run), `byPlatform` (per platform, `positiveRate`). **No longer returns** `highlights` / `brandCorrelation` / `positionAnalysis` / `platformEnhanced` (2026-09-20) — verbatim evidence → `get_brand_mention_samples`, polarity → `get_competitor_polarity`. `source` echoes `derived\|live` (same numbers). Unknown platform code → error | `time_range: 7d\|30d\|90d\|180d, platform` |
| `get_risk_context_sources` | **Cited sources** of the AI Verdict page (`/performance/verdict › Sources` tab), same read model as the page (2026-09-20): per domain cited by answers that carry aspect votes in the window — `kind` (owned\|review\|community\|media\|rival\|commerce\|reference\|other), `citedRecords`, `negativeShare` (share of those answers where the brand's **own** entity got a `negative` aspect vote), `topAspects` (≤2), `delta`, `isNew`; plus `kpis` (`domains`, `ownedRecords`, `worstDomain`, `newDomains`) and `domainsTotal`. Window follows `time_range` (default 7d = the old fixed window; 30d / custom allowed, cold cost is high on large brands); no `lift` field any more; aspect votes exist only since 2026-09-08. Co-occurrence, not causation | `time_range (7d, 30d, custom), start_date, end_date, platform` |
| `get_brand_mention_samples` | Sample recent answers mentioning the brand: raw text + sentiment + extracted context | `time_range, platform, limit (1–30), answer_max_chars (200–4000)` |

---

## F. Brand-own — audits & GA4 (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_audit_list` | GEO site audits (AI-readiness diagnostics), paginated history | `page, page_size (1–50)` |
| `get_audit_detail` | One audit's full detail: per-category scores, issues (critical/warning/passed, each capped ~25 with `_counts`) | `audit_id` |
| `get_ga4_traffic_data` | GA4 integration: sessions, page views, distribution. Pass `page_path` for **page-level** data instead (page views, sessions, bounce rate, engagement, conversions, traffic sources incl. AI sources, daily trend) | `property_id (optional), time_range, comparison_mode: previousPeriod\|previousMonth\|previousYear, page_path (optional — page-level mode)` |

---

## G. Brand-own — write tools (require consent **write** grants)

| Tool | Purpose | Params |
|---|---|---|
| `create_prompt` | Create a new monitoring prompt | `text, category, priority, country (default US), topic_id, tags[]` |
| `archive_prompt` | Archive a prompt (stops monitoring, cancels in-flight collection, moves it to the Archived tab) or restore it with `restore=true`; idempotent (`changed=false` when already in that state). Read archived ones with `get_prompt_list status=archived` — no separate read tool | `prompt_id, restore (bool, default false)` |
| `update_prompt_tags` | Batch tag edit, same as the /prompts bulk actions: `add` / `remove` tags on a set of prompts (≤500), or `rename` one tag brand-wide. Foreign prompts are skipped. Tags are read back via `get_prompt_list` rows | `action: add\|remove\|rename, prompt_ids[], tags[], old_name, new_name` |
| `move_prompts_to_topic` | Move prompts (≤500) into a topic of this brand, or `topic_id=null` to ungroup — the /prompts "move to topic" bulk action | `prompt_ids[], topic_id (nullable; from get_topic_list)` |
| `create_topic` | Create a prompt topic (unique within brand, case-insensitive) | `name, description` |
| `create_competitor` | Add a competitor to track (unique name, auto-clean domains) | `name, domains[], aliases[]` |
| `trigger_prompt` | Run monitoring for a prompt now (**consumes credits**) | `prompt_id` |

---

## H. Report tools (user-scoped, no brand gate)

| Tool | Purpose | Params |
|---|---|---|
| `get_agent_ready_scans` | List Agent Readiness scan history for the token owner | `limit (1–100, default 20)` |
| `get_agent_ready_scan_detail` | Full Agent Readiness scan result by ID | `scan_id` |

---

## I. Public source domains (read-only, available to all tokens)

These read cross-topic public citation-source data and need no brand context (NOT Grow-gated).

| Tool | Purpose | Params |
|---|---|---|
| `get_public_sources_overview` | Most-cited public source domains across all topics (cross-topic leaderboard). Each row's `score` = **AI DA** (0–100 AI Domain Authority: citation share + placement + breadth) | `limit (1–200), type` |
| `get_public_source_domain_detail` | Profile one citation source domain with the **same read models as the /industry/sources/[domain] page**: usable citations, `aiDa`, `topicCoverage` (first page ≤20, all-history, with `dominance` + `trend`), `coOccurringBrands` (first page ≤20), `topUrls` (first page ≤20 — **since 2026-09 windowed by `period` 30d (default) \| 90d** anchored on the domain's latest usable citation day, like the page; was: all history). Each list carries `page/pageSize/hasMore/total` under `lists`. Calibers: headline counts come from the last sealed batch (may trail live lists ~1 day); `coOccurringBrands` only counts pairs with **≥10 co-occurring answers within one topic** (absent ≠ zero); `totalAppearances`/`usableRate` are deprecated, always null | `domain, include_scorecard (bool — adds the full AI DA scorecard: authority/placement/breadth sub-scores, rank + pool size, momentum, confidence, integrity), period: 30d\|90d (default 30d, topUrls only), platform (default chatgpt)` |
| `get_public_source_brand_conduit` | The topics where one source domain's citations co-occur with one brand (top 30) — the contexts in which this source funnels AI toward that brand. Same ≥10-per-topic threshold: empty = nothing **above** the threshold, not strictly zero | `domain, public_brand_id, platform` |

---

## J. Public / industry tools (29) — Grow tier and above

The cross-brand competitive-intelligence surface (multi-org: enabled when any accessible org
qualifies). Full playbook + locale/platform conventions
in [public-tools.md](./public-tools.md). Most data tools accept an optional `platform` (default
`chatgpt`) — discover valid platforms per scope with `get_available_platforms`. **Time window
(since 2026-09)**: the windowed public tools default to the **latest published 30d batch
window** the web pages use (was: all history); every windowed tool takes `range: 30d|60d|90d|all`
and explicit `date_from`+`date_to`, and echoes the resolved `window`. Get the anchor first with
the free `get_public_data_window` — details in public-tools.md § Time window convention. Quick
index (26 current entry points + 3 public deprecated aliases from § Deprecated = 29 registered here; the other 3 deprecated aliases, `get_competitor_overview`, `get_brand_citations_daily` and `get_ga4_page_data`, are brand read-only tools counted in the 37 — 6 deprecated names in total):

**Resolve & browse**: `get_public_data_window` (free — batch anchor + 30/60/90d windows),
`search_public_entities`, `list_public_topics`, `list_public_locales`, `get_available_platforms`
**Topic**: `get_public_topic_overview`, `get_public_topic_brand_leaderboard`,
`get_public_topic_som_trend`, `get_public_topic_prompt_matrix`, `list_public_topic_prompts`,
`get_public_topic_prompt_detail`, `get_public_topic_record_detail`,
`get_public_topic_citation_domains`, `get_public_topic_commerce`,
`get_topic_competition_difficulty`
**Brand**: `get_public_brand`, `get_public_brand_rank_citation` (AIO-only Rankings × AI Citations), `get_public_brand_perception`
(mode=`profile` | `aspect_mentions` — the per-aspect drill-down), `compare_public_brands`
**Category / product-space**: `get_public_category`, `get_category_whitespace`,
`get_category_brand_momentum`
**AI-search intelligence**: `get_public_search_queries` (incl. mode=`territories` — demand-root
ownership map; mode=`query_detail` / `theme_detail` — one query / one topic drill-down)
**Shopping**: `list_public_shopping_boards` (cross-category AI shelf: hot/climbers/entrants,
batch-vs-batch), `get_public_shopping_product_detail` (one product's full analysis; mode=`card`
for the cheap preview), `list_public_shopping_products`

---

## Count by registration source (max surface)

Counts are the largest configuration (single-org token + write grants + Grow-tier+; multi-org
adds the 2 selectors but clamps the 7 write tools). A brand-bound, read-only, lower-tier token
sees far fewer.

| Source | Count |
|---|---|
| Read-only (brand + GA4 + public-source + `get_brand_context` + `get_current_date` + `resolve_page_context`) | 39 |
| Discovery selectors (`list_brands`, `list_organizations`) — multi-brand/org only | 2 |
| Write (consent write grants) | 7 |
| Report (user-scoped) | 2 |
| Quota (`get_quota`, always registered) | 1 |
| Public / industry (Grow+) | 29 |
| **Max total** | **80** |

> `get_discovered_links` is in `MCP_EXCLUDED_TOOLS` (its source tool `fetch_page` is in-app
> only) and is **not registered at all** — it is not part of the 39. Display sections A–J above
> regroup these for navigation; `get_brand_context`, `get_current_date` and `resolve_page_context` live under both
> "discovery" (display) and the read-only count (source). The counts include the deprecated
> aliases below (they are still registered).

## Deprecated (still registered)

These names still exist on MCP so existing integrations keep working — each one forwards to its
parent tool and returns exactly what it always did, at the same price. Their descriptions start with
`[DEPRECATED → <parent>]`. **Do not pick them for new work**; call the parent with the
equivalent arguments instead.

| Deprecated tool | Call this instead |
|---|---|
| `get_competitor_overview` | `get_platform_matrix` with `dimension="competitor"` (same query, same price; response shape of the alias unchanged) — see docs/mcp/COMPETITOR_TOOLS_CALIBER_AUDIT_2026-09.md §1.3 |
| `get_brand_citations_daily` | `query_analytics` with `dataset="brand_citations_daily"`, `dimensions=["date","platform"]` (+ `"platformName"`), full metrics list (see § query_analytics recipe) |
| `get_ga4_page_data` | `get_ga4_traffic_data` with `page_path` |
| `get_public_brand_perception_aspect_mentions` | `get_public_brand_perception` with `mode="aspect_mentions"`, `aspect=<normalized_label>` |
| `get_public_search_query_detail` | `get_public_search_queries` with `mode="query_detail"` (`query` + `product_space_id`) or `mode="theme_detail"` (`topic_id`) |
| `get_public_shopping_card_detail` | `get_public_shopping_product_detail` with `mode="card"`, `product_space_id` (days 1–90 there; the alias still accepts 1–180) |

### Retired facets / modes (still served, with a `_deprecated` notice)

Retired on 2026-09 under the three-step rule (mark → keep a compatibility forward for one
release → delete). They still answer for now but carry a `_deprecated` notice in the response
and will be removed in the next skill release — **do not start new work on them**:

| Tool / facet | Why | Use instead |
|---|---|---|
| `get_public_brand` / `compare_public_brands` view=`exposure_quality`, `segments`, `topic_flow`, `presence_trend` | Tool-only arena facets computed live from raw mentions; no page renders them; ~50% of calls timed out | `visibility` (+`include_trend`), `competitors`, `footprint` on the same window; diff two windows yourself for movement |
| `get_public_search_queries` mode=`queries`, `themes`, `brand_landscape`, `prompt_map` | The /industry/search page moved to a global batch-anchored model on 2026-07-23; these all-history readers have no page equivalent | mode=`territories` (demand ownership), `get_public_search_query_detail` (one query), `get_public_category` view=`topics`/`brand_leaderboard`, `list_public_topic_prompts` + `get_public_topic_prompt_detail` |

## Not on MCP (in-app agent only — do not call these over MCP)

These exist in the codebase but never reach MCP — either listed in `MCP_EXCLUDED_TOOLS` or
defined outside the read-only registration set (in-app agent / audit flows only):
`web_search`, `fetch_page`, `get_discovered_links`, `display_data`, `display_chart`,
`report_page_analysis`, `generate_site_report`, `get_analysis_reports`, `get_report_detail`,
`save_analysis_report`, `create_action_tasks`. Calling them over MCP returns "unknown tool".
