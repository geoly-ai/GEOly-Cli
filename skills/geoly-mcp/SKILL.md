---
name: geoly-mcp
description: "Use when querying or reporting on AI brand visibility through the GEOly MCP server — picking the right tool, following the org/brand discovery flow, quoting the correct KPI caliber, and avoiding metric-definition pitfalls. Triggers: GEOly; GEO / AI-visibility reporting; citation rate, mention rate, AIGVR, Share of Model; daily trends; competitor, category whitespace, brand momentum; any call to get_brand_overview / query_analytics / get_prompt_* / get_citation_* / compare_public_brands / get_category_* / get_public_* tools."
metadata:
  author: geoly
  version: "0.2.0"
---

# GEOly MCP

[GEOly](https://www.geoly.ai) tracks how brands are mentioned and cited across AI engines (ChatGPT, Gemini,
Perplexity, Grok, Google AI). The MCP server exposes **up to 62 tools** (the exact set depends
on plan, mode, and write profile) across two surfaces:

- **Self / brand-own** — the customer's own monitoring, audits, GA4, and write actions.
- **Public / industry** — cross-brand competitive intelligence (Grow tier and above).

The data is correct; **most mistakes are caliber mistakes** (mixing aggregations of the same
metric name) or **flow mistakes** (calling a brand tool before resolving which brand).

## If the GEOly tools aren't available in this session (pre-flight auto-authorize)

If the GEOly MCP tools (e.g. `list_brands`, `get_brand_overview`) are **not** in your available
tool list — or a call fails to connect — the `geoly` server is registered but not usable in *this*
session, usually for one of two reasons: it was **never authenticated** (Codex shows an **Authenticate /
进行身份验证** button next to `geoly` under *Settings → MCP servers*), or the session **started
before** it was authenticated. Fix it **proactively** — don't make the user hunt for the button,
and do **not** probe the endpoint by hand (a raw HTTP request without the stored OAuth token
returns `401`, which is expected and proves nothing). Run this pre-flight, in order:

1. **Open the sign-in window for them.** Run the shell command `codex mcp login geoly`. For this
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
- **Public tools** require a **Grow-tier-or-above** plan (`grow | advanced | plus | enterprise`)
  in **single-org** context. If `get_public_*` / `compare_public_brands` / `get_category_*`
  aren't available, the org lacks the tier or an active entitlement.
- **Writes** (`create_prompt`, `create_topic`, `create_competitor`, `trigger_prompt`) require the
  **standard** (write) profile, chosen on the OAuth consent screen; the default is read-only, and
  the legacy `geom_` static token is always read-only. `trigger_prompt` **consumes credits**.
- **Dates**: call `get_current_date` before building date ranges; `query_analytics` ranges ≤ 366 days.

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
  0 ok / 1 tool error / 2 usage / 3 auth / 4 rate-limited / 5 subscription / 6 upstream.
- Windows gotcha: `.env` files are not read — persist tokens with
  `[Environment]::SetEnvironmentVariable('GEOLY_TOKEN','geom_…','User')`.

## Tool selection — question → tool

### Self / brand-own
| You want… | Use |
|---|---|
| Headline KPI (AIGVR / mention / citation rate, whole window) | `get_brand_overview` |
| Daily/weekly **trend** of those metrics | `get_brand_citations_daily` |
| A topic / text-defined **subset** daily series | `query_analytics` dataset=`topic_citations_daily` (+ `prompt_text_include/exclude`) |
| Per-prompt visibility; search/list prompts | `get_prompt_list` (per-prompt rate in `geoMetrics.aigvr.citationRate`) |
| One prompt's full detail (per-platform, SoM, competitors) | `get_prompt_detail` |
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

### Public / industry (Grow tier and above)
| You want… | Use |
|---|---|
| Resolve a brand/category/topic name → IDs | `search_public_entities` |
| Category leaderboard / who leads | `get_public_category` view=`brand_leaderboard` |
| Where to invest (winnable topics) | `get_category_whitespace` |
| Who's gaining/losing share | `get_category_brand_momentum` |
| What AI is being asked in our space | `get_public_search_queries` → `get_public_search_query_detail` |
| Compare 2–4 brands head-to-head | `compare_public_brands` (country+language **required**) |
| How AI perceives a brand | `get_public_brand_perception` → `…_aspect_mentions` |
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
