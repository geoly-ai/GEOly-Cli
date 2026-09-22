---
name: geoly-mcp
description: "Use when querying or reporting on AI brand visibility through GEOly — via the geoly CLI (geoly run / geoly call) or the GEOly MCP server: routing a question to the right entry point, following the org/brand discovery flow, quoting the correct KPI caliber, and avoiding metric-definition pitfalls. Triggers: GEOly; geoly CLI; GEO / AI-visibility reporting; citation rate, mention rate, AIGVR, Share of Model; daily trends; competitor, category whitespace, brand momentum; any call to get_brand_overview / query_analytics / get_prompt_* / get_citation_* / compare_public_brands / get_category_* / get_public_* tools."
metadata:
  author: geoly
  version: "0.5.2"
---

# GEOly MCP

[GEOly](https://www.geoly.ai) tracks how brands are mentioned and cited across AI engines (ChatGPT,
Perplexity, Google AI Mode, Google AI Overview, Gemini, Copilot). The MCP server exposes **up to 80 tools** (the exact set depends
on plan, mode, and write grants) across two surfaces:

- **Self / brand-own** — the customer's own monitoring, audits, GA4, and write actions.
- **Public / industry** — cross-brand competitive intelligence (Grow tier and above).

The data is correct; **most mistakes are caliber mistakes** (mixing aggregations of the same
metric name) or **flow mistakes** (calling a brand tool before resolving which brand).

## First: which door are you at? (decide this before anything else)

There are two ways to reach GEOly and the right one is decided by **what is in this session**,
not by preference:

1. **The `geoly` CLI is on PATH** (check once: `geoly --version`) →
   **hand the question to `geoly run`** (CLI ≥ 0.3.0) — one command, see below. Do **not**
   rebuild the answer yourself out of `geoly tools` / `geoly schema` / `geoly call` chains: the
   hosted agent behind `run` already knows the calibers, routes the tools, handles timeouts and
   returns one receipt. The user installed the CLI precisely so that you would use it this way.
   `geoly call <tool>` is for a **specific raw pull** the user asked for by name, loops over many
   brands/prompts, or exports to files — not for answering questions.
   - **Version < 0.3.0** (no `run` subcommand): run `geoly upgrade` first (present since 0.1.0;
     self-updates the released binary) and re-check `geoly --version`. If it cannot upgrade
     (no route to the release host, not a released binary, user declines), **stay at this door
     in its older shape** — `geoly tools` → `geoly schema <tool>` → `geoly call <tool>`, using
     the tool-selection tables and calibers in this skill. Do **not** drop into the MCP
     pre-flight below: the CLI is installed, and the pre-flight only exists for hosts that have
     no CLI. (If the MCP tools also happen to be mounted, they are the same tools — either is
     fine.)
   - **Not signed in / credentials expired** (pre-installed CLI, never logged in; token expired;
     CI without `GEOLY_TOKEN`) — this is **exit code 3**, and it is still door 1, not a reason
     to switch doors. Any `geoly` command signs in lazily by itself; what you see depends on the
     machine:
     - browser available → it opens the browser and waits; a slow return is the user signing
       in, not a hang. Re-run the same command once it returns.
     - no local browser (SSH / container / Linux without a display — auto-detected, or force
       with `geoly auth login --remote`) → it prints a sign-in URL, then stops with exit 3 and a
       `next` line. Relay the URL to the user, run the `geoly auth login --code <code>` it
       printed, then re-run the command.
     - `CI=true` (or `--no-auto-auth`) → it fails fast with exit 3 and never opens anything:
       set `GEOLY_TOKEN` (a `geom_…` static token) and re-run.
     This is the same sign-in as step 2 of the bootstrap below; only the install step is
     skipped because the binary is already there.
2. **GEOly MCP tools are mounted** (`get_brand_overview`, `list_brands`, … in your tool list)
   and there is no CLI → use the tools directly with the rest of this skill.
3. **Neither** → the CLI is the fastest route to a working setup (one install line, one
   `geoly init`); see the CLI section. Only fall back to the MCP pre-flight below if the user's
   client is an MCP-only host (Claude Desktop, Cowork, cloud agents without a shell).

Never search for MCP tools for more than one try when the CLI is available, and never end a turn
by asking the user to run `geoly` themselves — you can run it.

## If the GEOly MCP tools aren't available in this session (pre-flight auto-authorize)

*(MCP-only hosts. If `geoly` is on PATH, skip this section — use the CLI.)*

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
`query_analytics` (dataset `brand_citations_daily`) returns **per-day** rates; averaging them
over-weights low-volume days and will NOT match the headline. For a window number, use
`get_brand_overview`, the `recordCitationRate` metric, or re-aggregate daily rows **weighted by
`completedRecords`**. The same name `citationRate` has three legitimate calibers — see
references/metric-calibers.md.

**3. A gap in a daily line means "no monitoring ran that day", not a missing metric.**
Read `completedRecords` per row (0 or absent = no collection). AIGVR, mentionRate and
citationRate share one daily denominator, so they always have identical date coverage.

**4. Verify the caliber before you quote a number.**
mention ≠ citation; AIGVR ≠ Share of Model; record-rate ≠ URL counts; the competitor tool
(`get_platform_matrix`; `get_competitor_overview` is its deprecated predecessor, same query) is record-weighted, never the headline. If
two numbers disagree, it is almost always a caliber/window/platform mismatch — reconcile, don't
guess.

**5. Resolve the brand before calling brand tools, then orient once with `get_brand_context`.**
In multi-brand / multi-org mode, call `list_brands` (and first `list_organizations`) and pass
`brand_id`. If a brand tool errors asking which brand, run the discovery tools first. Once the
brand is known, call `get_brand_context` **once** (free): it returns the brand and organization,
today's dates on all three axes (UTC / business day / `record_date_key`), the platforms that
actually have data in the last 30 days, topic and competitor ids, the data window and remaining
credits — so you do not spend separate calls on `get_current_date`, `get_competitor_list` or
`get_available_platforms` afterwards.

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
  - In every mode, the first brand call of a session is `get_brand_context` (free, one shot):
    brand + org + today + platforms-with-data + topics + competitors + data window + credits.
- **Public discovery flow** (any cross-brand / `get_public_*` work): **① `get_public_data_window`
  (free)** → the "as of" anchor: public collection is a weekly batch and every public page windows
  its figures as "latest PUBLISHED batch day, back 30/60/90 days"; since 2026-09 the windowed
  public tools default to that 30d window (was: all history) and echo `window` in every response —
  keep all calls on one `range` and quote `window.from`–`window.to`. ② `search_public_entities` →
  ids/slugs. ③ `list_public_locales` / `get_available_platforms` → a valid locale/platform.
  ④ the typed data tool. Details: references/public-tools.md § Time window convention.
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
- **Writes** (`create_prompt`, `create_topic`, `create_competitor`, `trigger_prompt`, `archive_prompt`, `update_prompt_tags`, `move_prompts_to_topic`) require
  **write access granted on the OAuth consent screen** (a per-resource read/write grid; the
  default is all-read, no-write). The legacy `geom_` static token is always read-only, and
  **multi-org connections are always read-only** (write grants are clamped). `trigger_prompt`
  really fires a scrape run (real work), so it always needs explicit intent — but it does
  **not** consume quota credits.
- **Dates**: take them from `get_brand_context.today` (`record_date_key` is the value the daily
  tools' `date` axis uses — one day behind the Asia/Shanghai business day) before building date
  ranges; `get_current_date` remains for the clock time. `query_analytics` ranges ≤ 366 days.

## What costs credits (and what's free)

Only the **public / industry-intelligence** tools consume quota credits, and only on **Grow-tier
or above**: the cross-brand `get_public_*`, `compare_public_brands`, `get_category_*`, and
`get_topic_competition_difficulty` tools, plus the ranked-content listings
`list_public_shopping_boards` and `list_public_topic_prompts` (1 credit/row). Everything else is
**free and unmetered** (within fair-use rate limits): your own brand's monitoring, audits, GA4,
and writes (including `trigger_prompt`), the three public source tools
(`get_public_sources_overview` / `get_public_source_domain_detail` /
`get_public_source_brand_conduit`), plus all discovery/navigation (`get_brand_context`, `list_organizations`,
`list_brands`, `search_public_entities`, `list_public_topics`, `list_public_locales`,
`get_available_platforms`, `get_public_data_window`, `get_quota`). So: **point an agent at the customer's own brand and full GEO reporting runs free**;
credits only meter cross-brand competitive intelligence.

### Spending credits wisely (only relevant once you touch public tools)

Credits are an org-wide monthly pool shared across all seats. To make them last **without
shipping a shallower report**:

1. **Discovery is always free — locate first, then pay to read.** Use the free
   `get_public_data_window` (time anchor) / `search_public_entities` / `list_public_topics` /
   `get_public_search_queries` (mode `product_spaces`) to find the window and the exact
   topic/brand/space id **before** spending on content tools.
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

## GEOly CLI — how an agent uses it

The CLI ([github.com/geoly-ai/GEOly-Cli](https://github.com/geoly-ai/GEOly-Cli)) is the gh-style
entry point: the user signed in once, the credential stays on their machine, you run commands.
Same tools, same calibers, same login as the MCP server. `geoly <command> --help` is
authoritative for flags — read it rather than guessing.

**Answer a question: `geoly run` (the default move)**

```
geoly run "<the user's question, in their words>"            # brand defaults to the signed-in brand
geoly run "<question>" --brand <brand_id>                     # multi-brand tokens: pin the brand
geoly run "weekly health" --spec weekly-brand-health          # server-defined deliverables
geoly run "<question>" --max-credits 200                      # cap the spend
```

- stdout is one JSON receipt (`status`, `run_id`, `answer`, `credits_cost`, `credits_remaining`,
  `saved_to`); progress is on stderr. Read `answer`; the full receipt is also at
  `./.geoly/runs/<run_id>.json` — read that file for long answers instead of re-running.
- **`status` is the contract.** `done` = answer ready. `running` = still going on the server
  (the command waits ~100 s then returns so your shell does not time out) — **not** a failure:
  run the `next` command it prints (`geoly runs wait <run_id>`) to pick it up. Never re-issue
  the same `geoly run` (retries within 10 minutes are idempotent anyway). `failed` = read `error`.
- Put the user's actual question in — do not translate it into tool names. The hosted agent
  does the routing, the caliber discipline and the timeout handling; if a heavy query times out
  it retries or narrows the window itself. Your job is to relay the answer, add your own
  judgement, and cite `run_id` if the user wants to look it up.
- `geoly run <run_id>` shows a run's state; `geoly runs list` finds recent ones;
  `geoly credits` shows both credit pools before something expensive.

**Raw data: `geoly call` (only when the user asks for a specific pull, or for loops/exports)**

- `geoly tools --json` — tool names come from the server at runtime; never assume.
- `geoly call get_brand_context` (add `--brand_id <id>` in multi-brand orgs) as the first data
  call of a script: one JSON object with the brand, today's dates, the platforms that have data,
  topic / competitor ids and remaining credits — feed those into the loop instead of calling
  `get_current_date` / `get_competitor_list` / `get_available_platforms` per iteration.
- `geoly schema <tool>` for exact parameters; `geoly call <tool> --help` also works.
- `geoly call <tool> --<param> <value> ...` — flags use schema parameter names **verbatim**
  (`--brand_id`, `--time_range 30d`); arrays/objects take JSON strings; whole-object via
  `--data '<json>'` or stdin via `--input -`. Results go to stdout as JSON (pipe to files).
- A `tool_error` on a heavy tool means the server timed out; narrow the window or use
  `geoly run` instead of retrying the same call.

**Exit codes** (from `geoly --help`): 0 ok (a `running` hand-off is also 0) / 1 tool or run error
/ 2 usage / 3 auth (sign in — see "Not signed in" under door 1; not a reason to leave the CLI)
/ 4 rate-limited / 5 subscription / 6 upstream / 7 credits exhausted.

**Bootstrap (only when `geoly` is not on PATH). "Headless" is about the browser, not the shell —
decide by what you have:**

| You have… | Do |
|---|---|
| A shell **and** a browser on this machine (laptop, desktop agent host) | Steps 1–3 below as written |
| A shell but **no** local browser (SSH, container, CI runner) | Do the bootstrap: step 1, then in step 2 sign in with `geoly auth login --remote` (paste-code) or `GEOLY_TOKEN`. This is the only route to a working setup here — do not skip it |
| **No shell at all**, or installs are forbidden (Claude Desktop, Cowork, a cloud agent that cannot run commands) | Skip the bootstrap; use the MCP pre-flight section above |

1. Install — zero-interaction, no sudo/admin:
   - macOS/Linux: `curl -fsSL https://geoly.ai/install.sh | sh`
   - Windows (from any shell): `powershell -ExecutionPolicy Bypass -c "irm https://geoly.ai/install.ps1 | iex"`
2. `geoly init` — opens the browser once for the user to sign in (a slow return while the
   browser is open is normal; wait, don't treat it as a failure) and installs this skill into the
   agent hosts on the machine. No browser on this machine (SSH, container)? `geoly auth login
   --remote` prints a sign-in URL; the user opens it anywhere and pastes the shown code back with
   `geoly auth login --code <code>`. Servers and CI set `GEOLY_TOKEN` instead; with `CI=true` the
   CLI fails fast (exit 3) rather than blocking.
3. Windows gotcha: `.env` files are not read — persist tokens with
   `[Environment]::SetEnvironmentVariable('GEOLY_TOKEN','geom_…','User')`.

## Tool selection — question → tool

### Self / brand-own
| You want… | Use |
|---|---|
| Orientation first: brand/org, today's dates, platforms with data, topic & competitor ids, credits | `get_brand_context` (free, once per run) |
| Headline KPI (AIGVR / mention / citation rate, whole window) | `get_brand_overview` |
| Daily/weekly **trend** of those metrics | `query_analytics` dataset=`brand_citations_daily`, `dimensions=["date","platform"]` |
| This period **vs the previous one** (week-over-week, month-over-month) with `days_with_data` | `query_analytics` with `compare_previous=true` (per-row `previous.*` / `delta.*`) |
| A topic / text-defined **subset** daily series | `query_analytics` dataset=`topic_citations_daily` (+ `prompt_text_include/exclude`) |
| Per-prompt visibility; search/list prompts (same calibers as the `/prompts` table; `summary` = the table's header bar) | `get_prompt_list` (per-prompt rate in `geoMetrics.aigvr.citationRate`; add `include_competitors=true` for SoM / competitors) |
| One prompt's windowed overview (visibility trend, Share of Mentions, competitor board, platform matrix, source domains — the `/prompts/[id]` page) | `get_prompt_detail` (`time_range` / `platform`) |
| Which competitors does the AI prefer **instead of** us, answer by answer (`weLose` per rival — the page's "who beats you" board; no weWin/tie any more) | `get_competitor_polarity` |
| Which cited sites ride along with **negative** aspect judgments of us (Verdict › Sources tab: `kind`, `citedRecords`, `negativeShare`) | `get_risk_context_sources` |
| A prompt's **full execution history** over a range (per-day records, e.g. 30-day shopping-card trend) | `list_prompt_records` (explicit `start_date`/`end_date` are UTC+8 business days) |
| **Read the actual answers** brand-wide — every AI answer in the window, filtered by topic / tag / country / platform / "mentions entity X" / "mentions us", paginated (= in-app /performance/answers) | `list_brand_answers` (`answerSummary` + `entities[]` + `sources[]` per row; drill one row with `get_prompt_record_detail`) |
| The actual **citation URLs / sources** for a prompt | `get_prompt_citations` (`deduplicate=true` for a source list) |
| "Which queries never mention us" (blind spots) | `get_prompt_mention_rates` |
| Citation **domain distribution / ownership** | `get_citation_overview` (counts URLs, not records; window = N whole +08 calendar days + today on the citation-creation axis — read `caliber` + `window` from the response) |
| One domain / one page deep-dive | `get_domain_detail` / `get_page_detail` (same `caliber` + `window` contract) / `get_url_reference_detail` |
| Content gaps for a domain | `get_content_opportunities` |
| Standing **vs competitors** | `get_brand_board` (**entity caliber** — the in-app /performance board: confirmed competitors, `visibility` = mentioned ÷ completed answers, same formula for you; add `topic_ids`/`country` for the scoped entity set, fail-closed) · `get_platform_matrix` `dimension=competitor` (legacy discovered-brand record-weighted — not headline; `get_competitor_overview` is its deprecated alias, same shape) |
| How AI *describes* the brand (verbatim) | `get_brand_mention_samples`; vs rivals → `get_competitor_cooccurrence` |
| Topic-level analysis | `get_topic_list` (ids, free) → `get_topic_analytics` (pass `topic_ids`) or `query_analytics` `topic_citations_daily` for day-level topic trends |
| Sentiment (brand-wide distribution / daily trend / per platform — no verbatim highlights, use `get_brand_mention_samples` for those) | `get_sentiment_dashboard` |
| The brand library (own brand + tracked competitors + system suggestions + removed), same rows as Settings › Brand | `get_competitor_list` (competitors = `status="tracked"` and `is_own_brand=false`) |
| Site AI-readiness audit | `get_audit_list` → `get_audit_detail` |
| Traffic (if GA4 connected) | `get_ga4_traffic_data` (add `page_path` for one page) |
| Archived prompts — list them | `get_prompt_list status=archived` (the /prompts Archived tab; no separate read tool). `get_prompt_detail` / `get_prompt_record_detail` work on archived prompts by id |
| Archive / restore a prompt | `archive_prompt` (write grant; `restore=true` to bring it back; idempotent). Archived prompts refuse `trigger_prompt` until restored |
| Tag prompts in bulk / rename a tag | `update_prompt_tags` (write grant): `action=add\|remove` with `prompt_ids` + `tags`; `action=rename` with `old_name` + `new_name` |
| Move prompts to a topic / ungroup | `move_prompts_to_topic` (write grant): `prompt_ids` + `topic_id` from `get_topic_list`, or `topic_id=null` |

> `display_data` / `display_chart` and `web_search` / `fetch_page` are **in-app agent only** —
> not exposed over MCP. MCP results are plain JSON (no `_ref`).
>
> `get_prompt_list` computes SoM / competitors only when you pass `include_competitors=true`
> (default rows carry `competitorsDeferred: true` and omit `som` / `competitorMentions`, like the
> page's first screen). `get_prompt_detail` is **windowed** (default 30 days) — its numbers are
> not comparable to the old all-time payload (`include_lifetime=true` still returns that,
> deprecated).

### Public source domains (every token — no plan gate)
| You want… | Use |
|---|---|
| Most-cited source domains across all AI answers, each with its **AI DA** (0–100 domain authority) | `get_public_sources_overview` |
| One source domain's profile; add `include_scorecard=true` for the AI DA breakdown (authority/placement/breadth + rank/momentum/integrity) | `get_public_source_domain_detail` |
| **Which topics a source funnels AI toward a brand** ("where does reddit.com steer AI to competitor X?") | `get_public_source_brand_conduit` |

### Public / industry (Grow tier and above)
| You want… | Use |
|---|---|
| The "as of" date + 30/60/90d windows the public pages use (call first; free) | `get_public_data_window` |
| Resolve a brand/category/topic name → IDs | `search_public_entities` |
| Category leaderboard / who leads | `get_public_category` view=`brand_leaderboard` |
| Where to invest (winnable topics) | `get_category_whitespace` |
| Who's gaining/losing share | `get_category_brand_momentum` |
| What AI is being asked in our space | `get_public_search_queries` mode=`territories` → same tool, mode=`query_detail` |
| Which brand OWNS each cross-topic demand root | `get_public_search_queries` mode=`territories` |
| Cross-category **AI shelf leaderboard** (hot / climbers / entrants, week-over-week) | `list_public_shopping_boards` |
| One category's AI shelf (latest batch vs previous, channels, price tiers) | `list_public_shopping_products` |
| One product's full AI analysis (shelves, trend, rivals, channels) | `get_public_shopping_product_detail` (mode=`card` for a cheap preview) |
| Compare 2–4 brands head-to-head | `compare_public_brands` (country+language **required**) |
| How AI perceives a brand | `get_public_brand_perception` → same tool, mode=`aspect_mentions` |
| Does Google ranking convert into AI Overview citations (AIO only) | `get_public_brand_rank_citation` (board → rows) |
| Is a topic worth targeting | `get_topic_competition_difficulty` |
| Bridge my brand → public dataset | `resolve_my_brand_public` (`bestMatch` = the in-app industry-profile decision; `ambiguous=true` means the app refuses to pick — do not guess from `candidates`) |

Cross-ref rule: for record counts/rates use `get_brand_overview` (not `get_citation_overview`,
which counts URLs); for trends use `query_analytics` dataset=`brand_citations_daily` (not by
paginating citations).
Window rule for the three citation tools (`get_citation_overview` / `get_domain_detail` /
`get_page_detail`): their `time_range` is **N whole Asia/Shanghai calendar days on the
citation-creation axis plus today** (matches the /citations page), not the rolling
`now − N×24h` window of `get_brand_overview` — never subtract one from the other; quote the
`window` each response returns. `caliber="legacy"` means the derived layer was unavailable and
the old query ran instead — its `window` then differs by tool: `get_citation_overview` reports
`startDay..endDay` **business days (+08)** on `prompt_record.record_date` (the old predicate is
day-granular, not an instant); `get_domain_detail` / `get_page_detail` report an exact
`start..end` instant pair on citation `created_at` (rolling N×24h). Quote whichever you got.

> Deprecated aliases (`get_competitor_overview`, `get_brand_citations_daily`, `get_ga4_page_data`,
> `get_public_brand_perception_aspect_mentions`, `get_public_search_query_detail`,
> `get_public_shopping_card_detail`) are still registered and forward to the tools above — do not
> pick them for new work; see tools-catalog § Deprecated for the equivalent call.

## Recipes

**KPI baseline (always start here)**
```json
{ "tool": "get_brand_overview", "args": { "time_range": "30d" } }
```
Read `aigvr.citationRate` / `aigvr.mentionRate` / `aigvr.score` — the report headline.

**Honest daily trend**
```json
{ "tool": "query_analytics",
  "args": { "dataset": "brand_citations_daily", "dimensions": ["date","platform"],
            "metrics": ["completedRecords","aigvr","mentionRate","citationRate","citationCount"],
            "start_date": "2026-05-28", "end_date": "2026-06-26" } }
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

**Period-over-period in one call (delta per platform, with coverage check)**
```json
{ "tool": "query_analytics",
  "args": { "dimensions": ["platform"], "metrics": ["completedRecords","mentionRate","citationRate"],
            "start_date": "2026-09-13", "end_date": "2026-09-19", "compare_previous": true } }
```
Each row carries `previous.mentionRate` / `delta.mentionRate` (percentage points). Quote
`window.current.days_with_data` vs `window.previous.days_with_data` alongside the delta — if the
current window has fewer collection days, say so instead of calling the change a trend.

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
