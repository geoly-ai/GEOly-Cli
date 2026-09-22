# GEOly metrics — calibers, definitions & data-shape pitfalls

_Use this when quoting any rate/score, reconciling two numbers that disagree, building a trend, or hitting a row/date/rate limit._

The GEOly numbers are correct. **Most reporting mistakes come from mixing calibers of
the same metric name, not from missing data.** This file is the authority on which
number to quote. When in doubt, the headline KPI always comes from `get_brand_overview`.

---

## 1. Metric glossary (definition · denominator · where to read it)

| Metric | Means | Denominator | Read from |
|---|---|---|---|
| **mentionRate** | % of answers that mention the brand | completed records | `get_brand_overview` (headline) |
| **citationRate** | % of answers that cite a brand-owned URL | completed records (prompt-equal) | `get_brand_overview` (headline) |
| **AIGVR** | composite visibility score `m × (0.4·position + 0.25·frequency + 0.25·citation)` | completed records | `get_brand_overview` (headline) |
| **Share of Mentions (SoM)** — prompt level | brand's share of mentioned answers vs the **auto-discovered / entity-layer** competitors of ONE prompt: brand somRanked records ÷ (somRanked + every competitor's mentioned records) | all brand-mentioned records of that prompt | `get_prompt_list` (`include_competitors=true`, `geoMetrics.som.share`) / `get_prompt_detail` (`overview.brandShare`, windowed) |
| **Share of Mentions (SoM)** — cross-prompt | **records-based**: each brand counts at most once per AI answer, vs **automatically discovered** competitors | all brand-mentioned records | `get_platform_matrix` (and the deprecated `get_competitor_overview`, same query; since 2026-07-24, was visibility-weighted) |
| **recordCitationRate** | pooled `cited records / completed records` (record-weighted) | completed records | `query_analytics` metric |
| **Entity visibility** (`brand_entity_v1`) | % of completed answers that mention the **brand entity** (own brand and each confirmed competitor on the **same** formula, pooled over covered days) | completed records in the covered window | `get_brand_board` (`ownBrand.visibility`, `rows[].visibility`) — the in-app `/performance` board |
| **Entity share** (`brand_entity_v1`) | mentionedRecords of one entity ÷ mentionedRecords of (you + all confirmed competitors), family-deduplicated | confirmed-set mentioned records | `get_brand_board` (`ownBrand.share`, `rows[].share`) |

Distinctions to never blur:
- **mention ≠ citation** — mentioned by name vs an actual brand-owned URL referenced.
- **citationRate (record-based) ≠ citation URL counts** — `get_citation_overview` counts
  URLs/domains, not records.
- **AIGVR ≠ SoM** — absolute visibility vs relative share against competitors.
- **Entity caliber ≠ discovered-brand caliber** — `get_brand_board` counts **brand entities** (dictionary-resolved, family-folded, confirmed set) with one formula for you and rivals; `get_competitor_overview` / `get_platform_matrix` count raw discovered-brand surfaces (record-weighted). Same window, different row sets and denominators — never merge their numbers in one table.

AIGVR formula reference: `V = m × (0.4·P + 0.25·F + 0.25·C)` where P = position score (1/pos),
F = frequency `min(mentions,3)/3`, C = citation (brand-owned URL present = 1), m = mentioned
multiplier. Aggregated **record-weighted** (each `prompt_record` counts equally) since release 3.11+.

---

## 2. The citationRate caliber trap (the #1 confusion)

The same name `citationRate` has **three legitimate values** — they differ on purpose:

| Value | Source | Aggregation | Use it as |
|---|---|---|---|
| **Headline (use this)** | `get_brand_overview.aigvr.citationRate` | whole-window, **prompt-equal-weight** | ✅ the KPI baseline |
| Per-day series | `query_analytics` `citationRate` (daily rows) | per-day prompt-equal | trend shape only — **never average it** |
| Record-weighted | `query_analytics` `recordCitationRate` | pooled cited/completed | reconcilable record-weighted figure |

A naive arithmetic mean of the daily series runs **~10–20 points higher** than the headline
(low-volume days get equal weight). That gap is not a bug — it is two different statistics.
For any KPI, quote the headline. The same caliber logic applies to mentionRate and AIGVR.

Per-prompt citation rate (same caliber as the headline) is available on
`get_prompt_list` / `get_prompt_detail` via `geoMetrics.aigvr.citationRate` — use it for
prompt-level breakdowns instead of re-deriving from raw citations.

---

## 3. Golden rules (apply every time)

1. **KPI baseline = `get_brand_overview`.** Its `aigvr.{score,mentionRate,citationRate}`
   are the headline numbers and match what the customer sees in the GEOly app. Quote these
   for any "what is our citation/mention/visibility rate" question. Nothing else is the headline.
2. **Never arithmetic-average a daily series.** `query_analytics` (dataset `brand_citations_daily`;
   the deprecated alias `get_brand_citations_daily` returns the same rows) gives **per-day** rates. For a window number use `get_brand_overview`, the `recordCitationRate`
   metric, or re-aggregate daily rows **weighted by `completedRecords`**.
3. **A gap in a daily line means "no monitoring ran that day", not "metric missing".**
   Read `completedRecords` per row: 0 or an absent row = no collection that day. AIGVR,
   mentionRate and citationRate share the same daily denominator, so they always have
   identical date coverage. If mention looks dense but citation looks sparse, you are reading
   a citation-event path, not the `brand_citations_daily` dataset.
4. **Respect truncation.** Large responses are capped, and the marker differs by surface:
   **brand tools** return structured `_truncated` / `_shownCount` / `_totalCount` fields (~60k
   cap); **public & report tools** (~120k cap) return a JSON envelope
   `{ "_truncated": true, "_originalChars": …, "_message": …, "preview": "<beginning of the
   original JSON — NOT complete>" }`. Either way, paginate or narrow — do not assume you got
   everything.

---

## 4. Data-shape pitfalls

- **Daily gaps** = no monitoring that day (cron / budget cadence). Read `completedRecords`,
  don't plot the gap as a zero.
- **Citation rarity**: a brand is *mentioned* far more often than it is *cited* (own-domain
  URL referenced). Sparse citations is the nature of the data, not a defect.
- **Pagination**: `get_prompt_list` returns `totalRows` / `totalPages` / `currentPage` —
  page until `currentPage == totalPages`; don't assume page 1 is complete. `prompts` is always
  an array; a top-level `_truncated: true` (+ `_totalCount` / `_shownCount`) means *this page*
  was cut to fit the output limit — lower `page_size`, it is not the end of the result set.
- **Prompt-level visibility has two calibers**: `get_prompt_list` rows are **record-weighted**
  (`geoMetrics.aigvr.score`, the table column); `get_prompt_detail.overview.brandVisibilityScore`
  is the **per-day average** (the overview caliber). Same prompt, same window, different number.
- **Mention rate numerator**: everything aligned to `position IS NOT NULL` (ranked) —
  `get_prompt_list geoMetrics.aigvr.mentionRate`, `get_prompt_detail.overview.mentionRate`,
  `get_prompt_mention_rates.rankedRate`, `get_brand_overview.rankedCount`. The deprecated
  `get_prompt_mention_rates.mentionRate` uses `mentions > 0` (= `mentionedCount`); by definition it
  can only be ≥ rankedRate, and in current production data the two are identical (2026-09-20,
  every brand, zero gap) — the alignment is about the predicate, not a number change.
- **Citations pagination**: raw mode (`deduplicate=false`) returns newest-first and is capped
  at 100/page; deep pages reach older days. Use `deduplicate=true` (up to 500/call) to get a
  URL-grouped source list with `share%` in one call and avoid deep paging.
- **Competitor caliber**: `get_platform_matrix` (and the deprecated `get_competitor_overview`,
  same query) is **record-weighted** SoM — never quote it as the brand headline KPI.
- **Competitor rows come from the brand-entity layer, not from the LLM's competitor list**
  (2026-09-20 audit, `docs/mcp/COMPETITOR_TOOLS_CALIBER_AUDIT_2026-09.md`): a competitor's
  `mentionedRecords` in `get_platform_matrix` counts answers where its name matched the brand's
  entity dictionary with `count_state = counted`. Ambiguous spellings (e.g. a bare brand word
  that is also a parent-brand or product-line name) stay `needs_context` until a confirming
  vote arrives — and votes only exist for answers analyzed since **2026-09-08**, so for older
  history a large share of hits is **not counted** (one large brand × one platform × 30d in the
  2026-09-20 audit: ~43% of a rival's name hits counted, ~39% needs_context, ~19% unmatched).
  That is why the matrix can show ~20% fewer answers for a rival than its LLM-judged rows:
  two populations, not a bug. The gap closes as pre-09-08 history rolls out of the window.
- **Verdict tools changed source on 2026-09-20** — `get_competitor_polarity` reads
  `brand_mention_vote.stance` (page "who beats you"): only `weLose`, top 5, ≥3 answers, votes
  since 2026-09-08; `get_risk_context_sources` reads the page's Sources tab (aspect votes ×
  citations, `negativeShare` = own-entity negative aspect votes, window follows `time_range`, default 7d).
  Neither reconciles with pulls made before that date (old: LLM three-state sentiment on
  `prompt_record_mentioned_brand` with a presence gate / record-level negative-mixed sentiment
  with a lift ratio, fixed 7d).
- **`get_competitor_cooccurrence` competitors are entities** (2026-09-20): names folded across
  spelling variants, each with `stance` and `mentions`; the legacy `position` / `isKnown`
  fields are gone. `summary.truncated = true` means the entity read hit its row fuse and the
  competitor lists were left empty on purpose — say so, do not report "no co-occurrence".
- **Entity board caliber** (`get_brand_board`, `caliber=brand_entity_v1`): `status=no-coverage`
  means the entity counting lane has not covered the window yet (coverage floor / lane catching
  up) — it is "not computed", not "nobody mentioned". `status=not-ready` on a topic/country
  filter means the derived layer is not ready and the tool refuses to substitute the unfiltered
  board (fail-closed). `ownBrand.pending=true` / `visibility=null` = the tenant has no own-brand
  entity yet — do not read it as 0%. `coverage.clamped=true` = the window was cut to the
  coverage floor; quote `coverage.floorDay` with the number.

---

## 5. Hard limits

- `query_analytics`: up to **1000 rows**; date range **≤ 366 days**.
- `get_prompt_citations`: raw mode **≤ 100/page**; `deduplicate=true` **≤ 500/call**.
- All-time citation queries are blocked (16M+ row table) — always bound by a time range.
- Rate limit **~120 requests/min per token** — batch with `query_analytics` instead of fanning
  out per-prompt citation calls.

---

## 6. Reconciliation cheat-sheet

If two numbers disagree, it's almost always a caliber mismatch. Check, in order:
1. Is one of them an **arithmetic mean of a daily series**? → it's inflated; use the headline.
2. Is one **record-weighted** (`recordCitationRate`, competitor tools) and the other
   **prompt-equal** (headline)? → both correct, different statistic; state which.
3. Is one **URL-count** (`get_citation_overview`) and the other **record-rate**? → counting
   different things.
4. Do the **date windows / platforms** match? → align `time_range` / `start_date`+`end_date`
   and `platform` before comparing. Note the three citation tools (`get_citation_overview` /
   `get_domain_detail` / `get_page_detail`) use **whole +08 calendar days on the
   citation-creation axis + today** (their `window` field says so), while `get_brand_overview`
   uses a rolling `now − N×24h` window on `record_date` — same `time_range`, different span.
5. Is one number from a pull **before 2026-07-23**? → see §7; several calibers were corrected
   that day and old pulls will not reconcile with fresh ones.

---

## 7. Caliber corrections shipped 2026-07-23 (old pulls will NOT match)

Four numbers changed **on purpose** — the new values are the correct ones. If an old report
disagrees with a fresh pull, the fresh pull wins:

1. **`get_brand_citations_daily.citationCount`** was **always 0** (a dead upstream table); it
   now returns the real count of citation URLs collected that day. It is a **different
   numerator** from `citationRate` (% of prompts whose answers cite a brand-owned domain) —
   never divide one by the other, and never treat pre-fix zeros as "no citations".
2. **`get_competitor_overview.brand.mentionRate`** is now a true mention rate (% of records
   with mentions>0). It was previously a mention **density** (total mentions ÷ records × 100)
   that could exceed 100. Expect a downward step vs old pulls (e.g. 154 → 59) — not a decline
   in performance, a definition fix.
3. **`get_prompt_list` no longer returns `geoMetrics.som`.** The list-level value was a
   constant placeholder (share=100, 0 competitors) that never reflected competition. Per-prompt
   SoM/competitor breakdown lives only on `get_prompt_detail`. *(Superseded 2026-09-20, see §8:
   the list computes real SoM since 2026-08-27 and returns it with `include_competitors=true`.)*
4. **Public AI-search query tools exclude echo rewrites** (the user prompt bounced back
   verbatim by the platform). All `get_public_search_queries` facets and drill-downs count
   fewer — but honest — queries than pre-fix pulls.
5. *(2026-07-24)* **`get_competitor_overview` (deprecated since 2026-09-20, shape unchanged) / `get_platform_matrix` `somShare` switched to
   records-based Share of Mentions** (each brand counts at most once per answer ÷ all
   brand-mentioned records; both tools now also return `mentionedRecords`), and their
   competitor roster is now **automatically discovered brands** — not the user-tracked
   competitor list (`get_competitor_list` returns the brand library — see §9). Old pulls used
   visibility-weighted shares over tracked competitors and will not reconcile.
   `get_prompt_detail`'s per-prompt SoM stays visibility-based vs tracked competitors.
   *(Superseded 2026-09-20, see §9.)*
6. *(2026-09-20)* **`get_citation_overview` / `get_domain_detail` / `get_page_detail` moved to
   the /citations page caliber**: the window is N whole Asia/Shanghai calendar days on the
   **citation-creation** axis plus today (was: `prompt_record.record_date` rolling N×24h for
   the overview, `created_at` rolling N×24h for the two details). Every response now carries
   `caliber` (`created-day`, or `legacy` when the derived layer is unavailable and the old
   window is used) and `window`. Domain ownership uses the page's three-way rule (you =
   brand.domain ∪ brand.website roots; competitor = registered ∪ caliber-discovered
   competitor roots; other). `get_citation_overview` dropped `brandMentions`,
   `brandMentionRate`, `uniqueUrls`, `dailyTrend[].brandMentions/brandMentionRate/brandUniqueUrls`,
   `trend.brandMentions`, `trend.domains` (record-axis mention counts mixed into citation
   data; use `get_brand_overview` / `query_analytics` dataset=`brand_citations_daily`), and added
   `ownership.competitorOwnedCitations` + `topDomains[].domainType`. Totals differ from
   pre-change pulls by the window-edge citations (typically a few percent for 30d).

---

## 8. Prompt-family tools re-based on the product pages (2026-09-20)

The prompt / record tools now read the **same functions as the in-app pages**. Old pulls will
not reconcile field-by-field:

1. **`get_prompt_list`** = the `/prompts` table (`getPromptsPage`). New: `summary` (the header
   bar: whole filtered set, record-weighted, with deltas), `status` (active / archived tab),
   `country`, `include_competitors`. `geoMetrics.som` is back and **real** (records-based Share of
   Mentions vs auto-discovered competitors) — but only with `include_competitors=true`; default
   rows omit `som` / `competitorMentions` / `delta.share` and carry `competitorsDeferred: true`.
   `prompts` is always an array (truncation flags moved to the top level).
2. **`get_prompt_detail`** = the `/prompts/[id]` page (`getPromptDetailOverview` +
   `getPromptSourceDomains`): **windowed** (`time_range`, default 30d) + `platform`, entity-layer
   competitors, `platformMatrix`, source-domain breakdown. `overview.brandVisibilityScore` is the
   per-day-average caliber. The old all-time payload (`recordsCount`, `citationsCount`,
   `geoMetrics`, `platformRecords`) is only returned under `lifetime` with `include_lifetime=true`
   (deprecated).
3. **`get_prompt_record_detail`** adds `mentionedEntities` (entity layer + per-answer `stance`,
   same source as the answer dialog); `mentionedBrands` and `competitors` are deprecated.
4. **`get_prompt_mention_rates`** sorts by and leads with `rankedRate` / `rankedCount`
   (`position IS NOT NULL`, the `/prompts` caliber); `mentionRate` / `mentionCount`
   (`mentions > 0`) are deprecated. Numbers do not move today (the two predicates agree on
   every current record); the tool now follows the page if they ever diverge.
5. **`get_brand_search_queries` mode=`prompt_queries`** follows `time_range` (default 30d) and
   `platform` (default all entitled) like the prompt detail page, instead of a fixed 90-day
   ChatGPT-only window; extra fields `platformCodes`, `totalQueries`, `echoDistinctCount`,
   `roots`, `competitorRoots`. Modes `roots` / `topic_roots` / `root_detail` are deprecated
   (forwarded, `_deprecated` note in the response).

---

## 9. Brand-side tools re-based on the in-app calibers (2026-09-20)

Four brand-scoped tools now read the **same functions the product pages use**. Where a field
changed meaning it was renamed or removed, never silently re-valued:

1. **`get_competitor_list` = the brand library** (Settings › Brand › Brands), sourced from the
   brand-entity layer instead of the legacy `competitor` table. A paged envelope
   (`rows[]`, `total`, `page`, `page_size`, `total_pages`, `counts`) — since 0.5.3; the earlier
   flat array overflowed the 60k output cap on libraries with a few hundred spellings and
   silently dropped rows. Rows carry `status: tracked | suggested | removed`; tracked rows
   include your own brand (`is_own_brand=true`) and every confirmed competitor entity (usually
   **more rows** than the old list — auto-confirmed brands were never in the competitor
   table). Competitors = `status="tracked" AND is_own_brand=false`. `mentions_30d` is the
   entity rollup's rolling 30-day mention count. `names[]` defaults to a **summary** (every
   user-added spelling + up to 12 learned ones) with `names_total` / `names_truncated` telling
   you what was left out; `entity_id` + `names="full"` returns one entity's complete alias list
   500 at a time (`names_offset` / `names_next_offset` — own-brand entities on large accounts
   run past 1,000 spellings). Legacy `id` / `domains` / `aliases` / `isActive` stay for one release but are
   **mapped** from the entity layer (`id` = competitor row id only for user-added rows, else
   null; `domains` = `[root_domain]`; `aliases` = the same spellings as `names[]`).
2. **`resolve_my_brand_public.bestMatch` is the /performance industry-profile decision**
   (domain root → exact normalized name / match terms → alias; each arm accepts only a single
   active public brand with public data). New `ambiguous` flag: `true` = collision, the app
   fails closed and so does the tool (`bestMatch=null`, `matched=false`). `candidates` keeps the
   old heuristic list (≤5) for context; `candidates[].matchedBy ∈ link|domain|name|alias` —
   heuristic rows are link / domain / name, and when matched `candidates[0]` is `bestMatch`
   carrying its own `matchedBy` (domain / name / alias). Decision cached 5 min; collisions
   re-probed every call.
3. **`get_sentiment_dashboard` slimmed to the three sections that have a pre-aggregated source**
   (`overview`, `trend`, `byPlatform`; numbers verified identical to the old aggregation on
   production). `highlights`, `brandCorrelation`, `positionAnalysis`, `platformEnhanced`
   (`avgMentions` / `avgPosition`) are gone. Reads the tenant daily rollup when available
   (`source: derived`), else one live aggregation (`source: live`) — same numbers.
4. **`get_available_platforms` `scope=brand`** uses the public brand page's existence probe:
   identical platform set, `recordCount` is `null`, order is display priority rather than volume.
   Other scopes unchanged.
