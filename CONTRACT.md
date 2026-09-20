# GEOly CLI — Public Command Contract (v0)

This is the stability contract scripts and agents can rely on. Anything not listed here may
change without notice.

## Stability three-way split

| Surface | Stability |
|---|---|
| Flags, output behavior, exit codes | **Stable** — breaking changes only with a major version |
| Command set listed below (interactive `geoly`, `ask`, `auth`, `tools`, `schema`, `call`, `upgrade`, `completions`) | Stable |
| Tool names and input schemas | **Not stable** — they come from the GEOly MCP server at runtime. Probe with `geoly tools --json` before calling. |

## Commands (v0.3)

```
geoly                       [--brand <id>] [--locale zh|en] [--continue]
                            [--workspace <dir>] [--allow-writes]
geoly init [--agent claude-code|codex|cursor] [--no-login]
geoly run "<question>" [--brand <id>] [--spec <slug>] [--context <text|@file>]
                       [--max-credits <n>] [--wait <sec>|--no-wait] [--no-save] [-o <file>]
                       [--idempotency-key <key>]
geoly run <run_id> [--wait <sec>]
geoly runs wait <run_id> [--wait <sec>] [--interval <sec>] [--no-save] [-o <file>]
geoly runs list [--brand <id>] [--limit <n>]
geoly credits
geoly auth login [--profile <name>] [--no-browser] [--remote] [--code <code>]
geoly auth status
geoly auth logout
geoly whoami
geoly tools [--json] [--refresh]
geoly schema <tool>
geoly call <tool> [--<param> <value> ...] [--input -] [--data '<json>']
geoly ask "<question>" [--brand <id>] [--locale zh|en]      # deprecated → geoly run
geoly upgrade
geoly completions <shell>
```

**Admission rule for new verbs** (borrowed from Google's `gws` helpers): if `geoly call` or
`geoly run` can already do it, it does not become a command. Flags control orchestration, not
output shape (output is `--output json|raw`, everywhere).

### `geoly run` — the hosted GEO agent

- **What it is.** One question in, one receipt out, from the server-side agent
  (`POST /api/agent/runs`): the server picks tools, runs them, bills the organization's AI
  Credits, and stores the run. The CLI only follows the SSE stream and renders. Prefer it over
  `ask` (a local loop kept for old scripts) and over hand-built `call` chains for anything that
  ends in a narrative.
- **Waiting.** Follows for `--wait` seconds (default 100 — under the 120 s an agent host
  usually gives one shell command). Not finished by then → exit **0** and
  `{"status":"running","run_id":…,"elapsed_s":…,"next":"geoly runs wait <id>"}`. The run keeps
  going on the server (server contract: disconnects never abort a run). `--no-wait` returns
  right after the server acknowledges the run. Ctrl-C does the same hand-off.
- **Picking up.** `geoly run <run_id>` prints the run's current state; `geoly runs wait <id>`
  polls `GET /api/agent/runs/<id>` every `--interval` seconds (default 3) for up to `--wait`
  seconds and prints the receipt when it lands; still running → the same `running` hand-off.
  `geoly runs list` finds recent runs when the id was lost.
- **`status` is the contract**: `done` / `failed` are final, `running` is not an answer.
  (The server's run log says `succeeded`; the CLI normalises it to `done` everywhere.)
- **Receipt.** `--output json` (default) prints the server's `done` payload plus `status`:
  `run_id`, `answer`, `stopped`, `stopped_reason`, `steps`, `tools_used`, `usage`,
  `credits_cost`, `credits_remaining`, `deliverable` (only with `--spec`), `saved_to`.
  `--output raw` streams the answer text and ends with the run id on its own line.
- **Receipt file.** Every finished run is also written to `./.geoly/runs/<run_id>.json` under
  the current directory (mode 0600) so agents can read long answers from disk instead of
  re-running; `--no-save` skips it, `-o <file>` chooses the path (stdout then only prints the
  path). Add `.geoly/` to `.gitignore`.
- **Idempotency.** Each `run` sends `Idempotency-Key = sha256(org, brand, spec, question,
  context, max_credits)` — every input that changes what the server would do, so changing any
  of them (a lower `--max-credits` included) is a new command, not a replay. Re-sending the same
  command within 10 minutes makes the server replay the existing
  run (JSON, `replayed: true`, and if it is still running the CLI goes straight to the
  `running` hand-off) — a shell that timed out and retried never pays twice.
  `--idempotency-key` overrides the key for scripts.
- **Failures.** A server-side `error` event → `kind: tool_error`, exit 1, `next: geoly run <id>`.
  HTTP errors map as for every other command (402 `subscription_required` / `quota_exhausted`,
  429 `rate_limited`, 5xx `upstream_unavailable`).

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

Three ways in, picked in this order:

1. **Browser round-trip (default, lazy)**: any command that needs credentials opens the
   browser, prints the authorization URL to stderr, waits on a loopback port (180s timeout),
   then continues. Concurrent commands share one flow. `--no-browser` prints the URL without
   opening a browser but still listens locally (WSL and similar).
2. **Paste-code (`--remote`)** for machines without a browser. Chosen automatically when
   `SSH_CONNECTION`/`SSH_TTY`/`SSH_CLIENT` is set, `CI` is truthy, or Linux has no
   `DISPLAY`/`WAYLAND_DISPLAY`. `geoly auth login --remote` registers the hosted redirect
   `https://app.geoly.ai/api/mcp/cli/code` (one extra consent for clients registered before
   it existed), prints the sign-in URL, and parks the PKCE verifier in
   `~/.geoly/pending-auth-<profile>.json` (10 minutes). The user signs in anywhere; the page
   shows a code; `geoly auth login --code <code>` exchanges it. In an interactive terminal
   the code is prompted for on the spot. A lazy-auth command in remote mode prints the URL and
   fails with exit 3 and `next: geoly auth login --code <code>` — it cannot block on a paste
   that may come from another window. A pending sign-in is reused by later commands rather
   than restarted, and only one is started per process.
3. **`GEOLY_TOKEN`** (static `geom_` token): read-only, never opens a browser. Servers and CI.

- Auto-degrade: when `CI=true`, `GEOLY_NO_AUTO_AUTH=1`, or `--no-auto-auth` is set, missing
  credentials fail fast with exit code 3 instead of blocking.
- `--org <id>` narrows the session to one organization (maps to the server-side org scope).
- The code shown on the hosted page is single-use, short-lived and useless without the
  verifier on this machine; relaying it through an agent's chat adds no exposure the agent
  does not already get from being able to run `geoly`.

## Output

- **stdout**: result JSON only. Pretty-printed in a TTY, compact when piped.
  `--output raw` returns the server's raw text.
- **stderr**: status and errors. Default is human-readable (What / Why / Hint).
  `--error-format json` switches errors to a stable object:
  `{ "kind", "status", "tool", "retryAfter", "hint", "next" }` (`next` = the exact command
  that moves things forward, when one exists)
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
| 2 | Usage error (bad flag / unknown tool / server rejected the parameters, JSON-RPC -32602) | Fix the command; check `geoly schema` |
| 3 | Auth (only in CI / `--no-auto-auth` / user cancelled) | Set `GEOLY_TOKEN` or complete browser auth once |
| 4 | Rate limited — HTTP 429 (after honoring `Retry-After`, max 3 attempts / 60s budget) or the server's in-band `GUARDED_RATE_LIMITED` / `CIRCUIT_OPEN` result (retried once within the same budget when `retry_after_seconds` allows) | Back off `retryAfter`, retryable |
| 5 | No active subscription (HTTP 402) | Human action required; don't retry |
| 6 | Upstream service error (5xx / timeout / in-band `TOOL_TIMEOUT`, which carries `retryAfter` ≈ 60s — the query keeps running and is cached) | Short back-off, retry the same call once |
| 7 | AI Credits for this period are used up (HTTP 402) | Don't retry; wait for the reset date in the hint, or raise the limit |

Agent turns retry themselves before giving up: a failure that happens **before the first
byte of the response stream** (edge 5xx, network blip, 429) is re-sent up to twice, honoring
`Retry-After`. A failure *after* bytes have arrived is never retried — the model already
produced output and the run was already billed for it, so re-sending would duplicate both.

The table above is rendered from one source (`src/errors.ts` `EXIT_CODE_TABLE`), which also
feeds `geoly <command> --help`; README mirrors it verbatim.

## Update & mirrors

- A daily, best-effort check (TTY only, 1.5 s budget) notices a newer binary **and** a newer
  published skill than the one installed in agent hosts; it only prints a line, never rewrites
  anything. `geoly upgrade` replaces the binary and refreshes the skill in hosts that have it.
- `GEOLY_INSTALL_BASE` (same variable the install scripts honour) points both the update check
  and `geoly upgrade` at a mirror (https on `*.geoly.ai` or github.com); anything else is
  ignored with a warning. With a mirror set, github.com is never contacted.

## Scope of v0.3

- Read-only: write tools return `kind: write_blocked`. Write support ships in a later
  release behind explicit `--yes` confirmation.
- Pagination parameters are passed through natively per tool (`page`/`page_size` or
  `limit`/`offset` — see each tool's schema).
