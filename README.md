# claude-code-github-ci-channel

[![CI](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml)

> MCP channel plugin that pushes GitHub Actions CI/CD results directly into running Claude Code sessions.

Built on the Claude Code Channels API (research preview, v2.1.80+).

## Architecture

```
GitHub Actions ──webhook──► [HTTP server :9443]
                                    │ HMAC-SHA256 verify
                                    │ parse event
                                    ▼
                         MCP notifications/claude/channel
                                    │
                                    ▼
                         Claude Code session (stdio)
                              │
                              └──► fetch_workflow_logs tool (on demand)
                                        │
                                        ▼
                               GitHub API /actions/runs/{id}/logs
```

When a CI run completes, Claude receives a structured notification and can:
- Diagnose failures by fetching full logs
- Suggest or apply fixes with full codebase context
- Report on build health trends

## Requirements

- [Bun](https://bun.sh) ≥ 1.1.0
- Claude Code ≥ 2.1.80 (channels research preview)
- GitHub personal access token (`actions:read` scope)

## Quick Start

```bash
# Install
git clone https://github.com/drmf-cz/claude-code-github-ci-channel
cd claude-code-github-ci-channel
bun install

# Configure
export GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export GITHUB_TOKEN="ghp_your_token_here"
export WEBHOOK_PORT=9443

# Register with Claude Code (research preview flag required)
# Add to .mcp.json — see docs/mcp-json-example.json
claude --dangerously-load-development-channels server:github-ci

# Expose webhook (local dev)
hookdeck listen 9443 github-ci
# or: cloudflared tunnel --url http://localhost:9443
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | No | `9443` | HTTP port for webhook receiver |
| `GITHUB_WEBHOOK_SECRET` | Yes (prod) | — | HMAC secret (set in GitHub webhook settings) |
| `GITHUB_TOKEN` | No | — | PAT for `fetch_workflow_logs` tool (`actions:read`) |

## Documentation

- [AGENTS.md](AGENTS.md) — Architecture, deployment, and plugin registration guide
- [docs/mcp-json-example.json](docs/mcp-json-example.json) — `.mcp.json` registration example
- [docs/channels-json-example.json](docs/channels-json-example.json) — `channels.json` example
- [docs/notify-claude.yml](docs/notify-claude.yml) — GitHub Actions workflow to add to your repo

## Development

```bash
bun test          # Run tests
bun run typecheck # TypeScript type check
bun run lint      # Lint with Biome
bun run build     # Build to dist/
```

## License

MIT
