# GEOly CLI

**The [GEOly](https://www.geoly.ai) command-line interface — built for agents.**

[GEOly](https://www.geoly.ai) tracks how brands are mentioned and cited across AI engines
(ChatGPT, Gemini, Perplexity, Grok, Google AI). This CLI is a thin terminal projection of the
GEOly remote MCP server: every command maps to the same tools, the same metrics, and the same
OAuth as the rest of the platform — so numbers never drift between surfaces.

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
# Discover the tools available to your account (plan/mode aware)
geoly tools --json

# Inspect a tool's parameters
geoly schema get_brand_overview

# Call it
geoly call get_brand_overview --time_range 30d
```

There is no login step: the first `geoly call` opens your browser for OAuth automatically,
then continues the command. On headless machines, run `geoly auth login --no-browser` — it
prints the authorization URL to open from any device, and credentials are cached after one
sign-in. If you still hold a legacy read-only `geom_` token, it is also accepted:

```sh
export GEOLY_TOKEN=geom_xxxxxxxx   # legacy, read-only — never triggers a browser
```

## Built for agents

- **Stable contract**: flags, output behavior, and exit codes are the stable surface.
  Tool names and schemas come from the server at runtime — check `geoly tools --json`
  before calling; the server can add tools without a CLI release.
- **stdout is data, stderr is status**: results are JSON on stdout (pretty in a TTY,
  compact when piped). `--error-format json` emits machine-readable error objects
  (`kind`, `status`, `retryAfter`, `hint`).
- **Exit codes**: `0` ok · `1` tool error · `2` usage · `3` auth · `4` rate-limited ·
  `5` subscription · `6` upstream.
- **Read-only by default** in v0. Write tools arrive in a later release behind explicit
  confirmation flags.
- An [Agent Skill](./skills/geoly-mcp/SKILL.md) ships with this repo — it teaches your agent
  the right tool for each question and the correct metric calibers.

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
