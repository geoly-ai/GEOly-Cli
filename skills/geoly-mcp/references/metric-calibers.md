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
| **Share of Model (SoM)** | brand's share of visibility **vs tracked competitors** | total brand+competitor visibility | `get_prompt_detail`, `get_competitor_overview`, `get_platform_matrix` |
| **recordCitationRate** | pooled `cited records / completed records` (record-weighted) | completed records | `query_analytics` metric |

Distinctions to never blur:
- **mention ≠ citation** — mentioned by name vs an actual brand-owned URL referenced.
- **citationRate (record-based) ≠ citation URL counts** — `get_citation_overview` counts
  URLs/domains, not records.
- **AIGVR ≠ SoM** — absolute visibility vs relative share against competitors.

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
2. **Never arithmetic-average a daily series.** `query_analytics` / `get_brand_citations_daily`
   give **per-day** rates. For a window number use `get_brand_overview`, the `recordCitationRate`
   metric, or re-aggregate daily rows **weighted by `completedRecords`**.
3. **A gap in a daily line means "no monitoring ran that day", not "metric missing".**
   Read `completedRecords` per row: 0 or an absent row = no collection that day. AIGVR,
   mentionRate and citationRate share the same daily denominator, so they always have
   identical date coverage. If mention looks dense but citation looks sparse, you are reading
   a citation-event path, not `get_brand_citations_daily`.
4. **Respect truncation.** Large responses are capped, and the marker differs by surface:
   **brand tools** return structured `_truncated` / `_shownCount` / `_totalCount` fields (~60k
   cap); **public & report tools** instead append a plain-text
   `… [truncated: response exceeded 120000 chars — narrow your query]` (~120k cap, no structured
   fields). Either way, paginate or narrow — do not assume you got everything.

---

## 4. Data-shape pitfalls

- **Daily gaps** = no monitoring that day (cron / budget cadence). Read `completedRecords`,
  don't plot the gap as a zero.
- **Citation rarity**: a brand is *mentioned* far more often than it is *cited* (own-domain
  URL referenced). Sparse citations is the nature of the data, not a defect.
- **Pagination**: `get_prompt_list` returns `totalRows` / `totalPages` / `currentPage` —
  page until `currentPage == totalPages`; don't assume page 1 is complete.
- **Citations pagination**: raw mode (`deduplicate=false`) returns newest-first and is capped
  at 100/page; deep pages reach older days. Use `deduplicate=true` (up to 500/call) to get a
  URL-grouped source list with `share%` in one call and avoid deep paging.
- **Competitor caliber**: `get_competitor_overview` / `get_platform_matrix` are
  **record-weighted** SoM — never quote them as the brand headline KPI.

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
   and `platform` before comparing.
