# GEOly CLI — Public Command Contract (v0)

This is the stability contract scripts and agents can rely on. Anything not listed here may
change without notice.

## Stability three-way split

| Surface | Stability |
|---|---|
| Flags, output behavior, exit codes | **Stable** — breaking changes only with a major version |
| Command set listed below (`auth`, `tools`, `schema`, `call`, `upgrade`, `completions`) | Stable |
| Tool names and input schemas | **Not stable** — they come from the GEOly MCP server at runtime. Probe with `geoly tools --json` before calling. |

## Commands (v0)

```
geoly auth login [--profile <name>] [--no-browser]
geoly auth status
geoly auth logout
geoly whoami
geoly tools [--json] [--refresh]
geoly schema <tool>
geoly call <tool> [--<param> <value> ...] [--input -] [--data '<json>']
geoly upgrade
geoly completions <shell>
```

- `geoly call` is the single execution entry point. Parameter flags use the MCP schema
  parameter names verbatim (including underscores, e.g. `--brand_id`). Booleans are
  presence-based. Arrays/objects take JSON strings. `--data '<json>'` passes the whole
  argument object; `--input -` reads it from stdin. Individual flags override same-name
  fields from `--data`/`--input`.

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
  upstream_unavailable | tool_error | usage_error | write_blocked`.
- Truncation/pagination signals from the server (`_truncated`, `hasMore`, `totalPages`) are
  preserved in the payload; the CLI adds a stderr hint when they appear.

## Exit codes

| Code | Meaning | Agent strategy |
|---|---|---|
| 0 | Success | — |
| 1 | Tool / general error | Read the error object; usually don't retry |
| 2 | Usage error (bad flag / unknown tool) | Fix the command; check `geoly schema` |
| 3 | Auth (only in CI / `--no-auto-auth` / user cancelled) | Set `GEOLY_TOKEN` or complete browser auth once |
| 4 | Rate limited (after honoring `Retry-After`, max 3 attempts / 60s budget) | Back off, retryable |
| 5 | Subscription / billing (HTTP 402) | Human action required; don't retry |
| 6 | Upstream service error (5xx / timeout) | Short back-off, retryable |

## Scope of v0

- Read-only: write tools return `kind: write_blocked`. Write support ships in a later
  release behind explicit `--yes` confirmation.
- Pagination parameters are passed through natively per tool (`page`/`page_size` or
  `limit`/`offset` — see each tool's schema).
