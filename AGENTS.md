# AGENTS.md — claude-code-github-ci-channel

## Architecture

This plugin has two transport layers running in the same process:

1. **HTTP (Bun.serve)** — receives GitHub webhook POSTs on `WEBHOOK_PORT` (default 9443)
2. **stdio (MCP)** — communicates with Claude Code via the standard MCP protocol

```
src/
├── index.ts          # Entrypoint: wires HTTP server + MCP transport
├── server.ts         # Core logic: HMAC verification, event parsing, MCP server
└── types.ts          # Shared TypeScript interfaces for GitHub webhook payloads
```

Key exports from `server.ts` (all unit-tested):
- `verifySignature(payload, signature)` — HMAC-SHA256 verification
- `parseWorkflowEvent(event, payload)` — converts webhook payload → CINotification
- `isActionable(event, payload)` — filters to only completed events
- `createMcpServer()` — returns configured McpServer with channel capability
- `startWebhookServer(mcp)` — starts Bun HTTP server

## Plugin Registration

### 1. Install dependencies

```bash
bun install
```

### 2. Add to `.mcp.json` in your project

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/index.ts"],
      "env": {
        "WEBHOOK_PORT": "9443",
        "GITHUB_WEBHOOK_SECRET": "your-secret",
        "GITHUB_TOKEN": "ghp_your_token"
      }
    }
  }
}
```

### 3. Register channel in `.claude/channels.json`

```json
{
  "github-ci": { "server": "github-ci" }
}
```

### 4. Start Claude Code with the channel flag (research preview)

```bash
claude --dangerously-load-development-channels server:github-ci
```

Once channels graduate from research preview, use `--channels github-ci`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | No | `9443` | HTTP port for webhook receiver |
| `GITHUB_WEBHOOK_SECRET` | Yes (prod) | — | HMAC-SHA256 secret — set in GitHub webhook settings |
| `GITHUB_TOKEN` | No | — | PAT with `actions:read` for `fetch_workflow_logs` tool |

**Generate a secure secret:**
```bash
openssl rand -hex 32
```

## Local Development with Webhook Tunneling

The webhook server must be reachable by GitHub. For local dev, use a tunnel:

```bash
# Option A: Hookdeck
brew install hookdeck/hookdeck/hookdeck
hookdeck listen 9443 github-ci
# Use the provided URL in GitHub webhook settings

# Option B: cloudflared
cloudflared tunnel --url http://localhost:9443

# Option C: ngrok
ngrok http 9443
```

## GitHub Webhook Setup

1. Go to your repo → **Settings → Webhooks → Add webhook**
2. Set **Payload URL** to your tunnel URL
3. Set **Content type** to `application/json`
4. Set **Secret** to your `GITHUB_WEBHOOK_SECRET` value
5. Select events: **Workflow runs**, **Workflow jobs**, **Check suites**, **Check runs**
6. Or use `docs/notify-claude.yml` workflow instead (doesn't require always-on server)

## Production Deployment (Hybrid Architecture)

The stdio MCP transport requires the server to run locally. For a team setup:

```
GitHub → [Remote HTTP receiver on Fly.io/Railway] → [Redis/queue]
                                                           ↓
                                              [Local MCP poller] → Claude Code
```

The remote receiver stores events; a local lightweight poller reads from the queue
and pushes via the MCP channel. See `docs/hybrid-deployment.md` for a full guide.

## Security Notes

- **HMAC verification** uses `timingSafeEqual` to prevent timing attacks
- **Without `GITHUB_WEBHOOK_SECRET`**: dev mode allows all requests (log warning emitted)
- **`GITHUB_TOKEN` scope**: use fine-grained PAT with `actions:read` only
- **Event filtering**: only `completed` actions push notifications — `queued`/`in_progress` are dropped
- **IP allowlisting** (recommended for production): use GitHub's `https://api.github.com/meta` `hooks` IPs

## Development Workflow

```bash
bun test              # Run tests
bun run typecheck     # TypeScript type check (tsc --noEmit)
bun run lint          # Biome linter
bun run lint:fix      # Auto-fix lint issues
bun run build         # Build to dist/
```

## Adding New Event Types

1. Add interfaces to `src/types.ts`
2. Add a case in `parseWorkflowEvent()` in `src/server.ts`
3. Update `isActionable()` if needed
4. Add tests in `src/__tests__/server.test.ts`
