# GEOly MCP — full tool catalog (up to 62 tools)

_Use this when you need a tool's exact parameters/enums/defaults, or to confirm whether a tool is exposed over MCP._

Ground-truth catalog of the tools the GEOly MCP server **registers**. This is the MCP surface
— several internal agent tools exist in the codebase but are NOT exposed over MCP (see
§ Not on MCP). Availability depends on **mode** and **plan**:

- **Discovery selectors** (`list_organizations`, `list_brands`) appear only in multi-brand /
  multi-org mode.
- **Write tools** require `?tool_profile=standard` (or `admin`); read-only by default.
- **Public tools** require a Grow-tier-or-above plan in single-org context.
- Brand-scoped tools auto-resolve the brand when the org has one brand or the token is
  brand-bound; otherwise pass `brand_id` (discover it via `list_brands`).

Parameter notation: `name: type (constraints, default)`. `time_range` is the shared enum
`7d | 30d | 90d` (default `30d`) **unless the row says otherwise**.

---

## A. Discovery & routing (3)

| Tool | Purpose | Params |
|---|---|---|
| `list_organizations` | List org IDs the token can access (multi-org mode only) | — |
| `list_brands` | List brand IDs in the org (multi-brand / multi-org only) | `org_id` (optional, multi-org only) |
| `get_current_date` | Server time, for date-range validation | — |

---

## B. Brand-own — overview & KPI (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_brand_overview` | **KPI headline**: AIGVR score + mention/citation rates + per-platform stats | `time_range` |
| `get_brand_citations_daily` | Daily trend of aigvr / mentionRate / citationRate with `completedRecords` denominator | `start_date, end_date (YYYY-MM-DD)`, `platform` |
| `query_analytics` | Controlled aggregation (no SQL) over daily datasets | see **§ query_analytics** below |
| `resolve_my_brand_public` | Bridge: resolve this monitored brand → its `public_brand` (ranked candidates + `availableLocales`) | — |

### query_analytics
- `dataset`: `brand_citations_daily | topic_citations_daily | topic_domain_citations_daily`
- `start_date, end_date` (YYYY-MM-DD; range ≤ 366 days)
- `dimensions[]`: `date | platform | topicId | topicName | domain`
- `metrics[]`: `citationCount | citedRecords | mentionCount | mentionedRecords | completedRecords | brandCitationRecords | aigvr | mentionRate | citationRate | recordCitationRate | sentiment.*` (`sentiment.positive/neutral/negative/mixed/unknown/scoredRecords/avgScore`)
- `platform`, `topic_id`, `topic_name`, `domain` (filters)
- `prompt_text_include`, `prompt_text_exclude` — **`topic_citations_daily` only**; define a prompt subset by text (live today)
- `limit`: 1–1000
- Returns `{ rows[], totalRows, _ref }` — `_ref` is for the in-app agent's display tools; MCP
  callers receive plain JSON and do not get a usable `_ref` (display tools aren't on MCP).

---

## C. Brand-own — prompts (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_prompt_list` | Search/list prompts with visibility stats; per-prompt rate in `geoMetrics.aigvr.citationRate` | `page, page_size (1–100), search, sort_by: text\|visibility\|position\|citations\|date, sort_order: asc\|desc, time_range, start_date, end_date, platform, tags[], topic[], topic_name` |
| `get_prompt_detail` | One prompt's full detail: per-platform performance, AIGVR, SoM, competitor mentions | `prompt_id` |
| `get_prompt_record_summaries` | Latest monitoring record per platform for one prompt | `prompt_id` |
| `get_prompt_record_detail` | Full detail of one monitoring record (answer, citations, sentiment) | `record_id, include_answer_text (bool, default false)` |
| `get_prompt_citations` | Citation list for a prompt — raw or deduplicated URL list with `share%` | `prompt_id, deduplicate (bool), limit (1–500), offset, time_range, start_date, end_date, sort_order: asc\|desc, platform, domain` |
| `get_prompt_mention_rates` | Per-prompt mention rate, **ascending** — blind-spot discovery ("which queries never mention us") | `time_range, min_records (1–100), limit (1–100), only_active (bool)` |

> Topic IDs/names: there is **no `get_topic_list` over MCP**. Discover topics via
> `get_topic_analytics` (returns per-topic rows) or the `topic_name` filter on `get_prompt_list`.
> On the public surface use `list_public_topics`.

---

## D. Brand-own — citations, domains & pages (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_citation_overview` | Citation **domain distribution** + ownership breakdown across the brand (counts URLs, not records) | `time_range, platform` |
| `get_domain_detail` | One domain's citation profile: trend, pages, prompts, platforms, regions | `domain, is_subdomain (bool), time_range, platform` |
| `get_page_detail` | One page URL's citation detail: trend, prompt distribution, text snippets | `url, time_range, platform` |
| `get_url_reference_detail` | A URL's references across **both** citations and search sources; arbitrary windows | `url, time_range: 7d\|30d (default 30d — no 90d), start_date, end_date, platform, prompt_id, limit_recent (1–100)` |
| `get_content_opportunities` | Content-gap analysis: prompts where a domain has low/no citations | `domain, time_range, platform` |

---

## E. Brand-own — competitors, topics, platform, sentiment (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_competitor_list` | Tracked competitors for the brand | — |
| `get_competitor_overview` | Cross-prompt competitor comparison (**record-weighted** — not headline caliber) | `time_range, platform` |
| `get_competitor_cooccurrence` | Brand + competitor co-occurrence: per-record detail + summary; optional answer text | `time_range, platform, limit (1–100), include_answer (bool), answer_max_chars` |
| `get_platform_matrix` | Comparison matrix: brand+competitors × platform, or topics × platform | `dimension: topic\|competitor (default competitor), time_range, platform` |
| `get_topic_analytics` | Per-topic analysis: sentiment, competitors, response types, trends. Also the way to enumerate topics over MCP | `time_range: 7d\|30d\|90d\|180d\|all\|custom (default 30d; custom requires start_date), start_date, end_date, platform, topic_ids[], include_ungrouped (bool)` |
| `get_sentiment_dashboard` | Sentiment: distribution, trends, platform comparison, brand correlation | `time_range: 7d\|30d\|90d\|180d, platform` |
| `get_brand_mention_samples` | Sample recent answers mentioning the brand: raw text + sentiment + extracted context | `time_range, platform, limit (1–30), answer_max_chars (200–4000)` |

---

## F. Brand-own — audits & GA4 (read-only)

| Tool | Purpose | Params |
|---|---|---|
| `get_audit_list` | GEO site audits (AI-readiness diagnostics), paginated history | `page, page_size (1–50)` |
| `get_audit_detail` | One audit's full detail: per-category scores, issues (critical/warning/passed, each capped ~25 with `_counts`) | `audit_id` |
| `get_ga4_traffic_data` | GA4 integration: sessions, page views, distribution | `property_id (optional), time_range, comparison_mode: previousPeriod\|previousMonth\|previousYear` |
| `get_ga4_page_data` | GA4 page-level: page views, sessions, bounce rate, traffic sources | `property_id (optional), page_path, time_range, comparison_mode` |

---

## G. Brand-own — write tools (require `tool_profile=standard|admin`)

| Tool | Purpose | Params |
|---|---|---|
| `create_prompt` | Create a new monitoring prompt | `text, category, priority, country (default US), topic_id, tags[]` |
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

These read cross-topic public citation-source data and need no brand context.

| Tool | Purpose | Params |
|---|---|---|
| `get_public_sources_overview` | Most-cited public source domains across all topics (cross-topic leaderboard) | `limit (1–200), type` |
| `get_public_source_domain_detail` | Profile one citation source domain: usable citations, per-topic coverage, co-occurring brands | `domain` |

---

## J. Public / industry tools (24) — Grow tier and above, single-org only

The cross-brand competitive-intelligence surface. Full playbook + locale/platform conventions
in [public-tools.md](./public-tools.md). Most data tools accept an optional `platform` (default
`chatgpt`) — discover valid platforms per scope with `get_available_platforms`. Quick index
(all 24):

**Resolve & browse**: `search_public_entities`, `list_public_topics`, `list_public_locales`,
`get_available_platforms`
**Topic**: `get_public_topic_overview`, `get_public_topic_brand_leaderboard`,
`get_public_topic_som_trend`, `get_public_topic_prompt_matrix`, `get_public_topic_prompt_detail`,
`get_public_topic_record_detail`, `get_public_topic_citation_domains`, `get_public_topic_commerce`,
`get_topic_competition_difficulty`
**Brand**: `get_public_brand`, `get_public_brand_perception`,
`get_public_brand_perception_aspect_mentions`, `compare_public_brands`
**Category / product-space**: `get_public_category`, `get_category_whitespace`,
`get_category_brand_momentum`
**AI-search intelligence**: `get_public_search_queries`, `get_public_search_query_detail`
**Shopping**: `list_public_shopping_products`, `get_public_shopping_card_detail`

---

## Count by registration source (max surface)

Counts are the largest configuration (multi-org token + `tool_profile=standard` + Grow-tier+).
A single brand-bound, read-only, lower-tier token sees far fewer.

| Source | Count |
|---|---|
| Read-only (brand + GA4 + public-source + `get_current_date`) | 30 |
| Discovery selectors (`list_brands`, `list_organizations`) — multi-brand/org only | 2 |
| Write (`tool_profile=standard+`) | 4 |
| Report (user-scoped) | 2 |
| Public / industry (Grow+) | 24 |
| **Max total** | **62** |

> The read-only 30 includes `get_discovered_links`, which is **inert over MCP** (its source
> tool `fetch_page` is in-app only) — so 29 are functionally useful. Display sections A–J above
> regroup these for navigation; `get_current_date` lives under both "discovery" (display) and
> the read-only count (source).

## Not on MCP (in-app agent only — do not call these over MCP)

These exist in the codebase but are excluded from MCP registration:
`web_search`, `fetch_page`, `display_data`, `display_chart`, `get_topic_list`,
`report_page_analysis`, `generate_site_report`, `get_analysis_reports`, `get_report_detail`,
`save_analysis_report`, `create_action_tasks`. Calling them over MCP returns "unknown tool".
