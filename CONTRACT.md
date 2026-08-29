# GEOly CLI — Public Command Contract (v0)

This is the stability contract scripts and agents can rely on. Anything not listed here may
change without notice.

## Stability three-way split

| Surface | Stability |
|---|---|
| Flags, output behavior, exit codes | **Stable** — breaking changes only with a major version |
| Command set listed below (interactive `geoly`, `ask`, `auth`, `tools`, `schema`, `call`, `upgrade`, `completions`) | Stable |
| Tool names and input schemas | **Not stable** — they come from the GEOly MCP server at runtime. Probe with `geoly tools --json` before calling. |

## Commands (v0)

```
geoly                       [--brand <id>] [--locale zh|en] [--continue]
                            [--workspace <dir>] [--allow-writes]
geoly auth login [--profile <name>] [--no-browser]
geoly auth status
geoly auth logout
geoly whoami
geoly tools [--json] [--refresh]
geoly schema <tool>
geoly call <tool> [--<param> <value> ...] [--input -] [--data '<json>']
geoly ask "<question>" [--brand <id>] [--locale zh|en]
geoly upgrade
geoly completions <shell>
```

- `geoly call` is the single execution entry point. Parameter flags use the MCP schema
  parameter names verbatim (including underscores, e.g. `--brand_id`). Booleans are
  presence-based. Arrays/objects take JSON strings. `--data '<json>'` passes the whole
  argument object; `--input -` reads it from stdin. Individual flags override same-name
  fields from `--data`/`--input`.
- **`geoly` with no arguments is the product**: an interactive session. You type, the agent
  works, you watch what it runs. `/help` lists the in-session commands (`/new`, `/memory`,
  `/tools`, `/exit`); Ctrl-C interrupts the running turn without ending the session, Ctrl-D
  exits. `--continue` resumes the most recent session for the resolved brand. Piped stdin
  (`echo "..." | geoly`) answers once and exits. Transcripts are written to
  `~/.geoly/sessions/<id>.jsonl`.
- `geoly ask` is the same agent, non-interactive, for scripts. The loop runs **in this
  process**: it fetches the system prompt and step budget from the server, lists your tools
  over MCP, and then drives the model — picking tools, running them, feeding results back —
  until it can answer. Inference is hosted and metered on your organization's plan; the loop,
  the transcript and the memory file stay on your machine. `--output raw` streams the answer
  to stdout as it arrives; the default `--output json` prints one envelope (`text`, `tools`,
  `steps`, `usage`, `brand`, `model`) at the end. Step/tool progress and the usage summary go
  to stderr (`-q` silences them). Requires an active subscription (402 →
  `subscription_required`); a per-organization daily model budget returns 429.
- **Context is managed locally**, in two layers:
  1. *Older tool results are abbreviated in place* after a couple of steps — a large result
     becomes a deterministic digest (shape, sample rows, totals) instead of being re-sent in
     full on every later step. Costs nothing, needs no model call. Your transcript on disk
     keeps the full text; only the copy sent to the model is shortened, and the agent can
     re-run the tool if it needs the detail back.
  2. *Past the server-set threshold, the conversation is summarized* (`⤳ compacted …` on
     stderr). The current question and the most recent work are always kept verbatim, and
     tool calls are never split from their results. This one costs a metered model call, so
     it only runs when layer 1 was not enough.

## Workspace

The agent can produce things, not just answer. `write_file` / `read_file` / `list_files`
operate inside one directory — the one you launched from, or `--workspace <dir>` — and paths
that resolve outside it are refused. Writes need your approval: in a session you are asked
once per file (`a` allows the rest of the session); with piped stdin or `geoly ask` nothing is
written unless you pass `--allow-writes`. Reads inside the workspace are allowed without
asking. Putting long output in a file also keeps it out of the model's context: the tool
result is "wrote 42KB", not the 42KB.

`update_plan` lets the agent publish a checklist for multi-step work, rendered as it changes.
The agent decides the steps and when they are done; the CLI only displays them.

## Tools

The agent starts with a working set rather than the whole GEOly tool surface: the paths that
account for ~90% of real usage, plus the local ones (files, memory, page fetch). Anything else —
audits, shopping shelves, ads, source scorecards, sentiment, locale and category browsing — it
pulls in on demand with `find_tools`, and you will see a `+ tool_name` line when it does. This
keeps the choice in front of the model small and relevant; nothing is out of reach.

## Web access

`fetch_page` runs **on your machine**: a plain HTTP client, no JavaScript execution — roughly
what a non-rendering crawler sees, which is the useful lens for GEO. It refuses private,
loopback and link-local addresses (including cloud metadata), re-checks every redirect hop,
and caps size and time. Nothing is proxied through GEOly, so it costs nothing.

Web search is the model's own: when it needs something it cannot get from GEOly data or a
known URL, it searches and cites what it used. You will see it as a `web_search` step like any
other tool. There is no separate search key or quota — the cost lands in the run's tokens.

## Memory

`geoly ask` reads `~/.geoly/memory/<brand-id>.md` at the start of every turn and puts it in
the agent's context. The agent writes to it through its `remember` tool; you write to it by
opening the file. Format is plain markdown — `## <slug>` heading, then the note. Up to 50
notes, 800 characters each; past that the agent is told to consolidate and decides what to
drop. Nothing is uploaded: memory is local, per machine, and not shared with your team.

## Authentication

- **Lazy OAuth (default)**: any command that needs credentials opens the browser
  automatically, prints the authorization URL to stderr, waits (180s timeout), then
  continues. Concurrent commands share one auth flow.
- **`GEOLY_TOKEN`** (static `geom_` token): read-only, never opens a browser. The CI path.
- Auto-degrade: when `CI=true`, `GEOLY_NO_AUTO_AUTH=1`, or `--no-auto-auth` is set, missing
  credentials fail fast with exit code 3 instead of blocking.
- `--org <id>` narrows the session to one organization (maps to the server-side org scope).

## Output

- **stdout**: result JSON only. Pretty-printed in a TTY, compact when piped.
  `--output raw` returns the server's raw text.
- **stderr**: status and errors. Default is human-readable (What / Why / Hint).
  `--error-format json` switches errors to a stable object:
  `{ "kind", "status", "tool", "retryAfter", "hint" }`
  with `kind` ∈ `auth_expired | grant_missing | rate_limited | subscription_required |
  quota_exhausted | upstream_unavailable | tool_error | usage_error | write_blocked`.
  `subscription_required` and `quota_exhausted` both arrive as HTTP 402 but need opposite
  responses: the first means there is no active subscription, the second means the plan is
  active and this period's AI Credits are spent (the hint carries the reset date).
- Truncation/pagination signals from the server (`_truncated`, `hasMore`, `totalPages`) are
  preserved in the payload; the CLI adds a stderr hint when they appear.

## Organization resolution

`--org` > this profile's remembered choice > the token's own scope. A token that can reach
several organizations makes `geoly` ask once — an arrow-key list with names, type to
filter — and remembers the answer
(`~/.geoly/settings-<profile>.json`); non-interactive runs (`ask`, piped stdin) never
prompt — they fail with the named list and the flag to add.

## Exit codes

| Code | Meaning | Agent strategy |
|---|---|---|
| 0 | Success | — |
| 1 | Tool / general error | Read the error object; usually don't retry |
| 2 | Usage error (bad flag / unknown tool) | Fix the command; check `geoly schema` |
| 3 | Auth (only in CI / `--no-auto-auth` / user cancelled) | Set `GEOLY_TOKEN` or complete browser auth once |
| 4 | Rate limited (after honoring `Retry-After`, max 3 attempts / 60s budget) | Back off, retryable |
| 5 | No active subscription (HTTP 402) | Human action required; don't retry |
| 6 | Upstream service error (5xx / timeout) | Short back-off, retryable |
| 7 | AI Credits for this period are used up (HTTP 402) | Don't retry; wait for the reset date in the hint, or raise the limit |

Agent turns retry themselves before giving up: a failure that happens **before the first
byte of the response stream** (edge 5xx, network blip, 429) is re-sent up to twice, honoring
`Retry-After`. A failure *after* bytes have arrived is never retried — the model already
produced output and the run was already billed for it, so re-sending would duplicate both.

## Scope of v0

- Read-only: write tools return `kind: write_blocked`. Write support ships in a later
  release behind explicit `--yes` confirmation.
- Pagination parameters are passed through natively per tool (`page`/`page_size` or
  `limit`/`offset` — see each tool's schema).
