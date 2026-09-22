# GEOly CLI

**The [GEOly](https://www.geoly.ai) command-line interface — for people and their agents.**

[GEOly](https://www.geoly.ai) tracks how brands are mentioned and cited across AI engines
(ChatGPT, Perplexity, Google AI Mode, Google AI Overview, Gemini, Copilot). The CLI works like
`gh`: you sign in once, the credential stays on your machine, and the agent you already use
(Claude Code, Codex, Cursor…) runs `geoly` commands on your behalf — it never sees a key.

- `geoly run "<question>"` — hand a whole question to GEOly's hosted GEO agent; get a receipt.
- `geoly call <tool>` — one raw data tool, JSON out. Same tools, metrics and OAuth as the MCP server.
- `geoly` — an interactive chat agent in your terminal, for when you want to dig in yourself.

## Install

**macOS / Linux**

```sh
curl -fsSL https://geoly.ai/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://geoly.ai/install.ps1 | iex
```

Self-contained single binary (no Node, no Python, no sudo — installs to `~/.local/bin`).
Targets: macOS (arm64/x64), Linux (x64/arm64), Windows (x64). Update any time with `geoly upgrade`.

Mirror (identical scripts, straight from this repo):
`curl -fsSL https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.sh | sh` ·
Windows: `irm https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.ps1 | iex`

## Quick start

```sh
# Sign in and teach the agent hosts on this machine (Claude Code / Codex / Cursor) about GEOly
geoly init

# Ask the hosted GEO agent — one JSON receipt on stdout, progress on stderr
geoly run "how did our ChatGPT visibility move this week?" --brand br_123

# Raw data: discover, inspect, call
geoly tools --json
geoly schema get_brand_overview
geoly call get_brand_overview --time_range 30d

# Both credit pools
geoly credits
```

**Signing in.** Any command that needs credentials opens your browser once and continues
(`geoly auth login` does it explicitly). No browser on this machine (SSH, a container)?
`geoly auth login --remote` prints a sign-in URL to open anywhere; the page shows a code you
paste back with `geoly auth login --code <code>` — this is picked automatically over SSH, in CI
and without a display. Servers and CI use a token instead:

```sh
export GEOLY_TOKEN=geom_xxxxxxxx   # server / CI — never triggers a browser
```

**Long runs.** `geoly run` follows a run for up to 100 s. If it is still going, the command
exits 0 with `{"status":"running","run_id":…,"next":"geoly runs wait …"}` — the run keeps
going on the server; run the `next` command to pick it up. The full receipt is also written to
`./.geoly/runs/<run_id>.json` (add `.geoly/` to your `.gitignore`). Re-running the exact same
command within 10 minutes replays the same run instead of paying for a new one.

**Read `stopped`, not only `status`.** A run that hit its `--max-credits` cap comes back
`status: done`, `stopped: max_steps`, `stopped_reason: budget` with a placeholder answer —
nothing failed, so the exit code is 0, but the CLI says on stderr that the answer is partial.

## Built for agents

- **Stable contract**: flags, output behavior, and exit codes are the stable surface.
  Tool names and schemas come from the server at runtime — check `geoly tools --json`
  before calling; the server can add tools without a CLI release.
- **stdout is data, stderr is status**: results are JSON on stdout (pretty in a TTY,
  compact when piped). `--error-format json` emits machine-readable error objects
  (`kind`, `status`, `retryAfter`, `hint`).
- **Exit codes** (`geoly <command> --help` prints the same table):

  ```
  0  ok (a `running` hand-off from `geoly run` is also 0 — it is not a failure)
  1  tool / run error — the server answered, the operation itself failed
  2  usage error — bad flags or parameters; nothing was sent
  3  auth — no valid credentials (run `geoly auth login`)
  4  rate limited — honor `retryAfter` before retrying
  5  subscription required — the organization has no active plan
  6  upstream unavailable — network / gateway trouble; a short back-off then retry is reasonable
  7  credits exhausted — this period's credits are used up
  ```
- **Help is plain text when piped** (`geoly --help | cat`), so agents can read it.
- **Writes need a go-ahead.** `archive_prompt`, `update_prompt_tags`, `move_prompts_to_topic`,
  `create_prompt` / `create_topic` / `create_competitor` and `trigger_prompt` (spends credits)
  only run after a `[y/N]` in a terminal or `--yes` in a script; the agent session asks the
  same way (`--allow-writes` for `ask`). They appear in your tool list only when the consent
  screen granted Write on that resource for ONE organization — `geoly whoami` shows
  `writeTools`, and a write tool you were not granted fails with `grant_missing` and the
  re-login hint.
- **Skills, installed for you.** `geoly init` writes the GEOly [Agent Skill](./skills/geoly-mcp/SKILL.md)
  into every agent host it finds (`~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`),
  fetching the current copy from app.geoly.ai; `geoly upgrade` refreshes it.

## Also available: remote MCP + Skill

The CLI, the MCP server, and the skill share one tool surface and one OAuth. If you prefer a
zero-install setup (Claude Desktop, Cowork, Codex, cloud agents), connect the remote MCP:

```json
{
  "mcpServers": {
    "geoly": {
      "type": "http",
      "url": "https://app.geoly.ai/api/mcp"
    }
  }
}
```

Codex users can install the plugin (MCP + skill) from
[geoly-ai/codex-plugins](https://github.com/geoly-ai/codex-plugins).

## License

[FSL-1.1-Apache-2.0](./LICENSE.md) — source-available; each release converts to Apache-2.0
two years after publication.

---

**[www.geoly.ai](https://www.geoly.ai)** · [Remote MCP docs](https://www.geoly.ai) · © GEOly
