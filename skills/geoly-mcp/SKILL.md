---
name: geoly-mcp
description: "Use when querying or reporting on AI brand visibility through the GEOly MCP server — picking the right tool, following the org/brand discovery flow, quoting the correct KPI caliber, and avoiding metric-definition pitfalls. Triggers: GEOly; GEO / AI-visibility reporting; citation rate, mention rate, AIGVR, Share of Model; daily trends; competitor, category whitespace, brand momentum; any call to get_brand_overview / query_analytics / get_prompt_* / get_citation_* / compare_public_brands / get_category_* / get_public_* tools."
metadata:
  author: geoly
  version: "0.5.0"
---

# GEOly MCP

[GEOly](https://www.geoly.ai) tracks how brands are mentioned and cited across AI engines (ChatGPT,
Perplexity, Google AI Mode, Google AI Overview, Gemini, Copilot). The MCP server exposes **up to 72 tools** (the exact set depends
on plan, mode, and write grants) across two surfaces:

- **Self / brand-own** — the customer's own monitoring, audits, GA4, and write actions.
- **Public / industry** — cross-brand competitive intelligence (Grow tier and above).

The data is correct; **most mistakes are caliber mistakes** (mixing aggregations of the same
metric name) or **flow mistakes** (calling a brand tool before resolving which brand).

## If the GEOly tools aren't available in this session (pre-flight auto-authorize)

If the GEOly MCP tools (e.g. `list_brands`, `get_brand_overview`) are **not** in your available
tool list, the `geoly` server may be unauthenticated or the session may have started before the
tools were mounted. If a tool is present but a call fails, **classify the error before taking any
auth action**. Do not turn every access error into a login loop:

| Error signal | What it means | Correct recovery |
|---|---|---|
| `AUTH_REQUIRED`, HTTP 401 with `WWW-Authenticate`, or the UI explicitly says unauthenticated | OAuth credentials are missing or invalid | Run the login flow below |
| `MCP_SETUP_REQUIRED` | The signed-in user has not completed workspace onboarding | Continue the browser setup opened by the MCP authorization flow; finish onboarding, then review the consent screen |
| `ORGANIZATION_REQUIRED` | GEOly could not find or prepare a usable organization | Ask the user to create/join an organization or contact GEOly support; do not re-login |
| `SUBSCRIPTION_REQUIRED`, `SUBSCRIPTION_INACTIVE`, or HTTP 402 | No selected organization has active entitlement | Send the user to `https://app.geoly.ai/settings/billing`; do not re-login |
| `ORG_SELECTION_REQUIRED` | The saved organization scope is no longer valid or includes unavailable organizations | Restart authorization and choose one active organization explicitly; do not re-login |
| Transport timeout / connection failure without an auth code | Network or client transport problem | Retry once, then inspect transport/client state; do not assume auth failure |

For a genuine auth-required or not-yet-mounted case, fix it **proactively** — don't make the user
hunt for the button, and do **not** probe the endpoint by hand (a raw HTTP request without the
stored OAuth token returns `401`, which is expected and proves nothing). Run this pre-flight, in
order:

1. **Open the sign-in window for them.** Only for the auth-required/not-mounted cases above, run
   the shell command `codex mcp login geoly`. For this
   OAuth (streamable-HTTP) server that starts the GEOly OAuth flow and opens the authorization page
   in the browser, so the user signs in with their GEOly account instead of hunting for the
   Authenticate button. (If a valid, unexpired login already exists, it usually completes without
   prompting for a new sign-in.) This command **blocks until the user finishes signing in** in the
   browser, so a slow return is normal — don't treat waiting as failure. They will still need to
   restart Codex (step 2) before the tools appear.
   - Only if you **cannot** run shell commands here, `codex` isn't on the PATH, or there is no
     browser available (headless): tell the user to click **Authenticate / 进行身份验证** next to
     `geoly` in **Settings → MCP servers**.
2. **Mount the tools.** GEOly's tools load at client startup, so after authorizing the user must
   fully **quit and reopen Codex** and start a **new** session — a new conversation in the
   still-running app is not enough (a fresh `codex exec` also loads them). Only then do
   `get_brand_overview` and the rest appear.
3. **If they still don't appear** after authorizing and a full restart, it's a client-side loading
   issue on Codex's side, not a GEOly problem — some Codex Desktop builds authenticate the server
   but never import its tools into the session. Have the user try the **Codex CLI** (`codex exec`,
   or a fresh CLI session), which is not affected by this Desktop import bug and generally mounts
   the tools after a fresh session.

Once the tools are mounted, continue with the user's request.

## Check for a newer version (once per session, non-blocking)

Your installed version is the `version` in this file's frontmatter (`metadata.version`). Before
your first GEOly tool call, do a quick, best-effort version check and mention it to the user only
if they're behind — then proceed with their request either way:

1. Read the latest published version: the `version` field of
   `https://raw.githubusercontent.com/geoly-ai/codex-plugins/main/plugins/geoly-mcp/.codex-plugin/plugin.json`
2. If that version is **newer** than your installed `metadata.version`, tell the user once, in one
   line: that a newer GEOly plugin (state the latest version) is available, they're on (state their
   installed version), and to update they should run `codex plugin marketplace upgrade geoly`, then
   `codex plugin add geoly-mcp@geoly`, then fully restart Codex / start a new session.
3. If the fetch fails, times out, or the versions already match, **say nothing** and continue. This
   check is best-effort and must never block or delay the user's actual request.

## Core Principles

**1. The KPI baseline is `get_brand_overview`.**
Its `aigvr.{score,mentionRate,citationRate}` are the headline numbers and match what the
customer sees in the GEOly app. Quote these for any "what is our citation/mention/visibility
rate" question. Nothing else is the headline.

**2. Never arithmetic-average a daily series.**
`query_analytics` / `get_brand_citations_daily` return **per-day** rates; averaging them
over-weights low-volume days and will NOT match the headline. For a window number, use
`get_brand_overview`, the `recordCitationRate` metric, or re-aggregate daily rows **weighted by
`completedRecords`**. The same name `citationRate` has three legitimate calibers — see
references/metric-calibers.md.

**3. A gap in a daily line means "no monitoring ran that day", not a missing metric.**
Read `completedRecords` per row (0 or absent = no collection). AIGVR, mentionRate and
citationRate share one daily denominator, so they always have identical date coverage.

**4. Verify the caliber before you quote a number.**
mention ≠ citation; AIGVR ≠ Share of Model; record-rate ≠ URL counts; competitor tools
(`get_competitor_overview`, `get_platform_matrix`) are record-weighted, never the headline. If
two numbers disagree, it is almost always a caliber/window/platform mismatch — reconcile, don't
guess.

**5. Resolve the brand before calling brand tools.**
In multi-brand / multi-org mode, call `list_brands` (and first `list_organizations`) and pass
`brand_id`. If a brand tool errors asking which brand, run the discovery tools first.

**6. Recover from errors, don't loop.**
A `402` / "subscription inactive" or a missing `get_public_*` tool is a gating signal, not a
transient error — check mode, subscription, and plan tier before retrying. Respect truncation
markers (`_truncated`/`_shownCount` on brand tools; a plain-text `[truncated …]` marker on
public/report tools) and paginate (`currentPage == totalPages`) instead of assuming completeness.

## Connection & access (what affects your calls)

- **Auth**: the client connects to `https://app.geoly.ai/api/mcp` (URL only) and authorizes via
  OAuth in the browser on first use — the user picks the org and read/write scope on the consent
  screen. The authorization maps to a user and the orgs they can access. A legacy read-only
  `Authorization: Bearer geom_…` static token is still accepted for headless/CI. You may pin a
  single org with `?org_id=<id>` (takes precedence over the consent org scope).
- **Mode → discovery flow** (decides whether brand tools need a `brand_id`):
  - **single** (one org, one brand, or brand-bound token) → brand tools auto-resolve; just call them.
  - **multi-brand** (one org, many brands) → first `list_brands`, then pass `brand_id`.
  - **multi-org** (several orgs) → first `list_organizations`, then `list_brands`, then pass IDs.
- **Subscription gate**: single-org / single-brand context returns **HTTP 402** at entry if the
  subscription is inactive. Multi-org validates **per target org at call time** and fails that
  org's tool call with an error message (not a 402).
- **Public tools** require a **Grow-tier-or-above** plan (`grow | advanced | plus | enterprise`).
  Multi-org connections get them too, as long as **any** accessible org qualifies. If
  `get_public_*` / `compare_public_brands` / `get_category_*` aren't available, no accessible
  org has the tier or an active entitlement. (The three public **source** tools —
  `get_public_sources_overview` / `get_public_source_domain_detail` /
  `get_public_source_brand_conduit` — are NOT plan-gated and are **free**: every token has
  them and they never consume quota credits.)
- **Writes** (`create_prompt`, `create_topic`, `create_competitor`, `trigger_prompt`) require
  **write access granted on the OAuth consent screen** (a per-resource read/write grid; the
  default is all-read, no-write). The legacy `geom_` static token is always read-only, and
  **multi-org connections are always read-only** (write grants are clamped). `trigger_prompt`
  really fires a scrape run (real work), so it always needs explicit intent — but it does
  **not** consume quota credits.
- **Dates**: call `get_current_date` before building date ranges; `query_analytics` ranges ≤ 366 days.

## What costs credits (and what's free)

Only the **public / industry-intelligence** tools consume quota credits, and only on **Grow-tier
or above**: the cross-brand `get_public_*`, `compare_public_brands`, `get_category_*`, and
`get_topic_competition_difficulty` tools, plus the ranked-content listings
`list_public_shopping_boards` and `list_public_topic_prompts` (1 credit/row). Everything else is
**free and unmetered** (within fair-use rate limits): your own brand's monitoring, audits, GA4,
and writes (including `trigger_prompt`), the three public source tools
(`get_public_sources_overview` / `get_public_source_domain_detail` /
`get_public_source_brand_conduit`), plus all discovery/navigation (`list_organizations`,
`list_brands`, `search_public_entities`, `list_public_topics`, `list_public_locales`,
`get_available_platforms`, `get_quota`). So: **point an agent at the customer's own brand and full GEO reporting runs free**;
credits only meter cross-brand competitive intelligence.

### Spending credits wisely (only relevant once you touch public tools)

Credits are an org-wide monthly pool shared across all seats. To make them last **without
shipping a shallower report**:

1. **Discovery is always free — locate first, then pay to read.** Use the free
   `search_public_entities` / `list_public_topics` / `get_public_search_queries` (mode
   `product_spaces`) to find the exact topic/brand/space id **before** spending on content tools.
2. **Budget at the start of a multi-tool research task.** Call `get_quota` (free) once up front;
   if `remaining` is low, prioritise the calls that carry the conclusion.
3. **Budget by rows returned, not by tier name.** Credits are charged **per row of data
   returned** (1/3/10 per row by tier), so cost scales with result size, not with the tool's
   "light/standard/deep" label. A single-object KPI (`get_public_brand` view=`visibility`) costs
   10 — one row — while a 50-brand `leaderboard` costs 150 (50 rows × 3). Estimate a call as
   `rows × per-row-rate`, and pass a `page_size`/`limit` no larger than you actually need (an
   over-large request pre-holds more, refunded down to the rows actually returned).
4. **Two-stage, quality-gated.** Cheap tools (`overview` views, `1`-credit lookups) are for
   **triage/locating** — deciding what's worth a deep read. But when the answer depends on
   evidence (rankings, momentum, perception, per-prompt records, competitive standing), you
   **must** still call the deep tool (`get_public_topic_prompt_matrix`, `compare_public_brands`,
   `get_public_brand_perception`, `get_public_topic_prompt_detail`, `get_category_*`). Never skip a
   deep call *to save credits* and hand back a thinner report — tell the user credits are low
   instead. Cost-efficiency means **not wasting** calls, not **under-delivering**.
5. **Don't blind-retry a wall.** `QUOTA_EXCEEDED` and `CIRCUIT_OPEN` are deterministic — retrying
   the identical call just fails again. Narrow the scope, switch to a cheaper tool that still
   answers, or tell the user the quota is exhausted (free tools still work). The `_quota` field on
   every paid result (`cost`, `remaining`, `warning`) is your running budget signal. When a
   `QUOTA_EXCEEDED` says `max_affordable_limit`, retry the same tool with `page_size`/`limit` set
   to that value — a smaller page still returns everything for a small topic.

## GEOly CLI — bulk & scripted access (optional; prefer for loops/exports)

The same tool surface is also a terminal CLI built for agents
([github.com/geoly-ai/GEOly-Cli](https://github.com/geoly-ai/GEOly-Cli)). Prefer it over MCP
tool calls when you need **loops over many prompts/brands, large exports piped to files, or
deterministic CI scripts** — results go to files instead of your context. For one-off
questions in a chat session, keep using the MCP tools.

**Bootstrap (only in a local shell environment; skip in cloud/headless sessions):**

1. If `geoly` is not on PATH, install it — zero-interaction, no sudo/admin:
   - macOS/Linux: `curl -fsSL https://geoly.ai/install.sh | sh`
   - Windows (from any shell): `powershell -ExecutionPolicy Bypass -c "irm https://geoly.ai/install.ps1 | iex"`
   - Mirror if the short domain path is unavailable: swap in
     `https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.sh` (or `install.ps1`).
2. **There is no login step.** The first `geoly call` opens the user's browser and continues
   after they approve — a slow return while the browser is open is normal; wait, don't treat
   it as a failure. In CI/headless, set `GEOLY_TOKEN` (read-only `geom_` token) instead;
   with `CI=true` the CLI fails fast (exit 3) rather than blocking.

**Usage pattern:**

- `geoly tools --json` first — tool names come from the server at runtime; never assume.
- `geoly schema <tool>` for exact parameters; `geoly call <tool> --help` also works.
- `geoly call <tool> --<param> <value> ...` — flags use schema parameter names **verbatim**
  (`--brand_id`, `--time_range 30d`); arrays/objects take JSON strings; whole-object via
  `--data '<json>'` or stdin via `--input -`.
- stdout is result JSON only (pipe to `jq`/files); status goes to stderr. Exit codes:
  0 ok / 1 tool error / 2 usage / 3 auth / 4 rate-limited / 5 subscription / 6 upstream /
  7 credits exhausted. `geoly --help` and `geoly <command> --help` are authoritative — read them
  before guessing flags.
- Windows gotcha: `.env` files are not read — persist tokens with
  `[Environment]::SetEnvironmentVariable('GEOLY_TOKEN','geom_…','User')`.
- No local browser (SSH, container)? `geoly auth login --remote` prints a sign-in URL; the user
  opens it anywhere, then pastes the shown code back with `geoly auth login --code <code>`
  (CLI ≥ 0.3.0).

**Delegate a whole question: `geoly run` (CLI ≥ 0.3.0 — check `geoly --version`):**

When the user's ask needs several tools plus synthesis (a weekly health read, a content brief, a
competitor comparison), hand the whole question to GEOly's hosted GEO agent instead of
orchestrating tools yourself — it knows the calibers, routes tools, and returns one answer plus a
credit receipt. Prefer `run` over ad-hoc `call` chains for anything that ends in a narrative.

- `geoly run "<question>" --brand <brand_id>` — stdout is one JSON object (the default
  `--output json`) with `status`, `run_id`, `answer`, `credits_cost`, `credits_remaining`, and
  `saved_to` (the full payload is also written to `./.geoly/runs/<run_id>.json` — read that file
  for long answers instead of re-running). `--output raw` streams the answer as text instead.
- Optional: `--spec <slug>` for a server-defined deliverable (e.g. `weekly-brand-health`,
  `content-brief`), `--max-credits <n>` to cap spend, `--context "<text>"` for extra input.
- **`status` is the contract.** `done` = answer ready. `running` = the run is still going on
  the server (the command waits ~100 s, then returns so your shell does not time out); it is
  **not** a failure — run the `next` command it prints (`geoly runs wait <run_id>`) to
  pick it up. Never re-issue the same `geoly run`; retries are idempotent for 10 minutes but
  waiting is cheaper. `failed` = read `error`.
- `geoly run <run_id>` shows a run's current state; `geoly runs list` finds recent ones;
  `geoly credits` shows both credit pools before you start something expensive.

## Tool selection — question → tool

### Self / brand-own
| You want… | Use |
|---|---|
| Headline KPI (AIGVR / mention / citation rate, whole window) | `get_brand_overview` |
| Daily/weekly **trend** of those metrics | `get_brand_citations_daily` |
| A topic / text-defined **subset** daily series | `query_analytics` dataset=`topic_citations_daily` (+ `prompt_text_include/exclude`) |
| Per-prompt visibility; search/list prompts | `get_prompt_list` (per-prompt rate in `geoMetrics.aigvr.citationRate`) |
| One prompt's full detail (per-platform, SoM, competitors) | `get_prompt_detail` |
| Which competitors does the AI prefer over us, answer by answer (weLose / weWin) | `get_competitor_polarity` |
| Which cited sites ride along with negative / mixed answers about us | `get_risk_context_sources` |
| A prompt's **full execution history** over a range (per-day records, e.g. 30-day shopping-card trend) | `list_prompt_records` (explicit `start_date`/`end_date` are UTC+8 business days) |
| The actual **citation URLs / sources** for a prompt | `get_prompt_citations` (`deduplicate=true` for a source list) |
| "Which queries never mention us" (blind spots) | `get_prompt_mention_rates` |
| Citation **domain distribution / ownership** | `get_citation_overview` (counts URLs, not records) |
| One domain / one page deep-dive | `get_domain_detail` / `get_page_detail` / `get_url_reference_detail` |
| Content gaps for a domain | `get_content_opportunities` |
| Standing **vs competitors** | `get_competitor_overview` / `get_platform_matrix` (record-weighted — not headline) |
| How AI *describes* the brand (verbatim) | `get_brand_mention_samples`; vs rivals → `get_competitor_cooccurrence` |
| Topic-level analysis (and to enumerate topics) | `get_topic_analytics` (pass `topic_ids`, or read its rows) — there is no `get_topic_list` over MCP |
| Sentiment | `get_sentiment_dashboard` |
| Site AI-readiness audit | `get_audit_list` → `get_audit_detail` |
| Traffic (if GA4 connected) | `get_ga4_traffic_data` / `get_ga4_page_data` |

> `display_data` / `display_chart` and `web_search` / `fetch_page` are **in-app agent only** —
> not exposed over MCP. MCP results are plain JSON (no `_ref`).
>
> `get_prompt_list` rows do **not** carry `geoMetrics.som` — per-prompt SoM/competitor breakdown
> is only computed by `get_prompt_detail` (list omits it for performance).

### Public source domains (every token — no plan gate)
| You want… | Use |
|---|---|
| Most-cited source domains across all AI answers, each with its **AI DA** (0–100 domain authority) | `get_public_sources_overview` |
| One source domain's profile; add `include_scorecard=true` for the AI DA breakdown (authority/placement/breadth + rank/momentum/integrity) | `get_public_source_domain_detail` |
| **Which topics a source funnels AI toward a brand** ("where does reddit.com steer AI to competitor X?") | `get_public_source_brand_conduit` |

### Public / industry (Grow tier and above)
| You want… | Use |
|---|---|
| Resolve a brand/category/topic name → IDs | `search_public_entities` |
| Category leaderboard / who leads | `get_public_category` view=`brand_leaderboard` |
| Where to invest (winnable topics) | `get_category_whitespace` |
| Who's gaining/losing share | `get_category_brand_momentum` |
| What AI is being asked in our space | `get_public_search_queries` → `get_public_search_query_detail` |
| Which brand OWNS each cross-topic demand root | `get_public_search_queries` mode=`territories` |
| Cross-category **AI shelf leaderboard** (hot / climbers / entrants, week-over-week) | `list_public_shopping_boards` |
| One product's full AI analysis (shelves, trend, rivals, channels) | `get_public_shopping_product_detail` |
| Compare 2–4 brands head-to-head | `compare_public_brands` (country+language **required**) |
| How AI perceives a brand | `get_public_brand_perception` → `…_aspect_mentions` |
| Does Google ranking convert into AI Overview citations (AIO only) | `get_public_brand_rank_citation` (board → rows) |
| Is a topic worth targeting | `get_topic_competition_difficulty` |
| Bridge my brand → public dataset | `resolve_my_brand_public` |

Cross-ref rule: for record counts/rates use `get_brand_overview` (not `get_citation_overview`,
which counts URLs); for trends use `get_brand_citations_daily` (not by paginating citations).

## Recipes

**KPI baseline (always start here)**
```json
{ "tool": "get_brand_overview", "args": { "time_range": "30d" } }
```
Read `aigvr.citationRate` / `aigvr.mentionRate` / `aigvr.score` — the report headline.

**Honest daily trend**
```json
{ "tool": "get_brand_citations_daily",
  "args": { "start_date": "2026-05-28", "end_date": "2026-06-26" } }
```
Plot as-is; treat absent days as "no collection" (check `completedRecords`). For a window value,
weight daily rates by `completedRecords` — don't simple-average.

**Citation sources for a prompt**
```json
{ "tool": "get_prompt_citations",
  "args": { "prompt_id": "<id>", "deduplicate": true, "limit": 500 } }
```

**Text-defined subset (e.g. non-branded), 3-metric daily series**
```json
{ "tool": "query_analytics",
  "args": { "dataset": "topic_citations_daily", "dimensions": ["date"],
            "metrics": ["aigvr","mentionRate","citationRate"],
            "prompt_text_exclude": "<brandword>",
            "start_date": "2026-05-28", "end_date": "2026-06-26" } }
```

**Competitive: where can we win a category**
```json
{ "tool": "search_public_entities", "args": { "query": "<my brand or category>" } }
```
→ `get_category_whitespace` with the resolved `product_space_id` + `public_brand_id`; act on the
`prioritize` / `gap` buckets.

## Reference Guides

- **Metric calibers, glossary & limits** → [references/metric-calibers.md](references/metric-calibers.md)
  **MUST read when** quoting any rate/score, reconciling two numbers that disagree, building a
  trend, or hitting a row/date/rate limit.
- **Full tool catalog (all registered tools + parameters)** → [references/tools-catalog.md](references/tools-catalog.md)
  **MUST read when** you need a tool's exact parameters/enums/defaults, or to confirm whether a
  tool is exposed over MCP.
- **Public / industry competitive-intelligence tools** → [references/public-tools.md](references/public-tools.md)
  **MUST read when** doing cross-brand work (leaderboards, whitespace, momentum, AI-search
  demand, perception, shopping) or anything involving the locale convention.
