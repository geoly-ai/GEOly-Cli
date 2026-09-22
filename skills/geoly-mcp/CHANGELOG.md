# Changelog

All notable changes to the `geoly-mcp` agent skill.

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
  `get_page_detail` moved to the /citations page window (N whole Asia/Shanghai days on the
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
