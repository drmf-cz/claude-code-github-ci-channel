# claude-code-github-ci-channel

[![CI](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml)

> MCP channel plugin that pushes GitHub Actions CI/CD results and PR merge status directly into running Claude Code sessions — triggering automatic investigation and remediation.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## What it does

The plugin runs inside your Claude Code session and listens for GitHub events. When something requires attention, it pushes an actionable instruction directly into the session — Claude reads it and acts on it immediately.

| GitHub event | Condition | What Claude does |
|---|---|---|
| `workflow_run` completed | failure on **main/master** | Fetches logs, diagnoses root cause, spawns subagent to fix and push |
| `workflow_run` completed | failure on feature branch | Fetches logs, spawns subagent to investigate |
| `workflow_run` completed | success | Silent — no notification |
| `push` to main/master | open PRs exist | Checks each PR's merge status via API, notifies on `dirty` or `behind` |
| `pull_request` opened/synced | `mergeable_state: dirty` | Spawns subagent to rebase and resolve conflicts |
| `pull_request` opened/synced | `mergeable_state: behind` | Spawns subagent to rebase cleanly |

> **Why `push` events for PRs?** GitHub does not fire a `pull_request` event when the base branch advances and makes a PR go `behind`. The only way to detect this is to listen to `push` on main and then query the API for open PRs.

## Architecture

```
GitHub Actions / PR / push event
          │  HMAC-SHA256 signed webhook
          ▼
[cloudflared tunnel]        ← free, no account needed for temp URLs
          │
          ▼
HTTP :9443  (webhook receiver — subprocess of Claude Code)
          │
          ├─ workflow_run/job/check_suite → parseWorkflowEvent()
          ├─ pull_request (dirty/behind)  → parsePullRequestEvent()
          └─ push to main                → checkPRsAfterPush() [async, API call]
                                                    │
                                                    ▼
                                        notifications/claude/channel
                                                    │
                                                    ▼
                                        Claude Code session
                                          ├─ fetch_workflow_logs tool
                                          └─ spawns subagents to fix/rebase
```

The MCP server is started automatically by Claude Code as a subprocess — you never run it manually.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1.0
- Claude Code ≥ 2.1.80
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (or ngrok)
- GitHub PAT — fine-grained: **Actions: Read** + **Pull requests: Read** | classic: `public_repo`

> `GITHUB_TOKEN` is required for two features: `fetch_workflow_logs` (log fetching) and `checkPRsAfterPush` (listing open PRs after a push). Without it, those features silently no-op.

## Setup (Option A — Webhook + Tunnel)

Real-time. Supports all event types including `workflow_job`, `check_suite`, and PR status.

### 1. Install

```bash
git clone https://github.com/drmf-cz/claude-code-github-ci-channel
cd claude-code-github-ci-channel
bun install
```

### 2. Generate a webhook secret

```bash
openssl rand -hex 32
# → copy the output — you'll paste it into GitHub and .mcp.json
```

### 3. Start the tunnel

```bash
cloudflared tunnel --url http://localhost:9443
# → prints: https://random-name.trycloudflare.com  ← copy this URL
```

Leave the tunnel running. Each restart produces a new URL — update GitHub when that happens.  
For a stable URL: [Cloudflare named tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) (free account) or [ngrok static domain](https://ngrok.com/blog-post/free-static-domains-ngrok-users) (free tier).

### 4. Register the webhook on GitHub

1. Repo → **Settings → Webhooks → Add webhook**
2. **Payload URL** — paste your tunnel URL
3. **Content type** — `application/json`
4. **Secret** — paste the value from step 2
5. **Which events** — choose *Let me select individual events*, then tick:
   - ✅ Workflow runs
   - ✅ Workflow jobs
   - ✅ Check suites
   - ✅ Pull requests
   - ✅ Pushes
6. Click **Add webhook** — GitHub sends a ping; you should see a green ✓

### 5. Configure `.mcp.json`

Create or edit `~/.mcp.json` (all projects) or `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/index.ts"],
      "env": {
        "WEBHOOK_PORT": "9443",
        "GITHUB_WEBHOOK_SECRET": "your-secret-from-step-2",
        "GITHUB_TOKEN": "your-pat"
      }
    }
  }
}
```

**Notes:**
- Use the **absolute path** to `bun` (`which bun`). Claude Code spawns subprocesses without your shell PATH.
- The `env` block here is the only config you need — no `.env` file required. Claude Code injects these directly into the subprocess.
- A `.env` file in the repo directory is loaded by Bun for manual runs only. `.mcp.json` values always take precedence.

### 6. Start Claude Code

```bash
claude --dangerously-load-development-channels server:github-ci
```

You should see:
```
Listening for channel messages from: server:github-ci
```

The server is now running. Push a commit, trigger a CI run, or let a PR fall behind — notifications will appear in your session automatically.

---

## Option B — GitHub CLI Events watcher (no tunnel)

No tunnel, no webhook config. Polls the [GitHub Events API](https://docs.github.com/en/rest/activity/events) using your existing `gh` CLI session.

**Trade-offs vs Option A:**
- ~30–60 s latency (server-dictated poll interval)
- `WorkflowRunEvent` only — no `workflow_job`, `check_suite`, or PR events
- No "behind PR" detection (Events API doesn't include pull request merge status)

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/ghwatch.ts"],
      "env": {
        "WATCH_REPOS": "owner/repo1,owner/repo2"
      }
    }
  }
}
```

Auth: uses `gh auth token` automatically. Override with `GITHUB_TOKEN` if needed.

Start the same way:
```bash
claude --dangerously-load-development-channels server:github-ci
```

---

## Environment variables

| Variable | Option A | Option B | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | optional | — | HTTP port for webhook receiver (default: `9443`) |
| `GITHUB_WEBHOOK_SECRET` | required | — | HMAC-SHA256 secret — must match GitHub webhook settings exactly |
| `GITHUB_TOKEN` | required* | optional | PAT for log fetching and PR status checks |
| `WATCH_REPOS` | — | required | Comma-separated `owner/repo` list |

\* Without `GITHUB_TOKEN`, `fetch_workflow_logs` and behind-PR detection silently no-op.

---

## Troubleshooting

### MCP shows red / "Failed to reconnect"

Port 9443 is likely still held by a previous session. Claude Code spawns the server as a subprocess — if an old one didn't exit cleanly, the new one fails to bind.

```bash
lsof -i :9443        # find the process
kill <PID>           # free the port
# restart Claude Code
```

The server logs: `ERROR: Port 9443 is already in use. Kill the existing process (lsof -i :9443) and restart Claude Code.`

### Webhooks return 401 Unauthorized

HMAC signature mismatch — the server and GitHub are using different secrets.

- **Most common cause:** a `.env` file in the repo directory has a different `GITHUB_WEBHOOK_SECRET` than `.mcp.json`. Bun loads `.env` automatically, but `.mcp.json` values take precedence. If you have both, make sure they match, or delete `.env`.
- Also check that the secret in `.mcp.json` exactly matches what was pasted into GitHub webhook settings (no extra whitespace).

### No notification when a PR falls behind

Check that **Pushes** is ticked in your GitHub webhook event settings. Without push events, the server never knows main has advanced. Also confirm `GITHUB_TOKEN` is set — it's required to query the PR list after a push.

### "bun: command not found" in MCP logs

Use the absolute path in `.mcp.json`: `"command": "/home/you/.bun/bin/bun"`. Find the path with `which bun`.

### `claude_desktop_config.json` vs `.mcp.json`

These are for different apps:
- `~/.config/Claude/claude_desktop_config.json` → Claude **Desktop** (GUI)
- `~/.mcp.json` or `.mcp.json` → Claude Code **CLI** (`claude` command)

`--dangerously-load-development-channels` reads from `.mcp.json`, not the Desktop config.

### Tunnel URL changed

Cloudflared free tier gives a new random URL on each restart. Update it: Repo → Settings → Webhooks → Edit → change Payload URL. For a permanent URL use a named tunnel or ngrok static domain.

---

## Development

```bash
bun test              # 32 tests
bun run typecheck     # tsc --noEmit (strict + noUncheckedIndexedAccess)
bun run lint          # Biome v2
bun run lint:fix      # Auto-fix lint issues
bun run build         # Bundle to dist/
```

## Security

- HMAC-SHA256 verification uses `timingSafeEqual` — constant-time, no timing oracle
- Fallback handler emits only `event + action + repo` — raw payload is never forwarded to Claude (prompt injection guard)
- `GITHUB_TOKEN` is read-only (`actions:read` + `pull_requests:read`) — no write access needed
- `.env` is gitignored — secrets stay local
- Dev mode (no `GITHUB_WEBHOOK_SECRET`): all requests accepted, warning logged — never deploy without a secret

See [AGENTS.md](AGENTS.md) for the full security analysis and architecture reference.
