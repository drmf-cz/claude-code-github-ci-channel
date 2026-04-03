# Multi-session setup (mux server)

> **Problem:** The default standalone server (`src/index.ts`) is spawned as a
> subprocess by Claude Code. Every session tries to bind the same port — only
> the first succeeds, and all other sessions miss webhook events.
>
> **Solution:** Run `src/mux.ts` once as a persistent process. Every Claude Code
> session connects to it via a single local URL instead of spawning a subprocess.

---

## How it works

```
GitHub ──► :9443 (webhook receiver)
                │
           [mux process]  ← runs once, you start it manually
                │
           :9444/mcp  (MCP Streamable HTTP — localhost only)
           ┌────┴────┐
      Session A   Session B   Session C  …
      (CC window) (CC window) (CC window)
```

- The mux process owns both ports. It is **not** managed by Claude Code.
- Each Claude Code session connects to `http://127.0.0.1:9444/mcp` as an HTTP
  client — no subprocess is spawned per session.
- Each session calls the `set_filter` tool once on startup to tell the mux
  which repo and branch it is currently working on.
- Webhook events are routed only to sessions whose filter matches.

---

## Setup

### 1. Create your `.env` file

```bash
cp .env.example .env
$EDITOR .env          # fill in GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN
```

Bun reads `.env` automatically from the working directory when you start
the mux. You never need to pass secrets on the command line.

### 2. Start the mux

```bash
# After global install (recommended) — reads .env from current directory
github-ci-mux
github-ci-mux --config /path/to/my-config.yaml   # with optional YAML config

# Or via bunx (no install needed — always uses latest published version)
bunx -p claude-code-github-ci-channel github-ci-mux

# Or from a cloned repo
bun run start:mux
```

You should see:

```
[github-ci:mux] MCP HTTP server listening on http://127.0.0.1:9444/mcp
[github-ci:mux] Webhook server listening on http://localhost:9443
[github-ci:mux] Mux ready — waiting for Claude Code sessions and webhook events.
```

Keep this process running — in a tmux pane, a background terminal, or as a
[systemd unit](#running-as-a-systemd-unit).

### 3. Register the mux in Claude Code

Instead of adding the server as a subprocess, add it as a URL-based MCP server.

**Via CLI (recommended — run once, applies globally):**

```bash
claude mcp add --transport http github-ci http://127.0.0.1:9444/mcp
```

**Via `.mcp.json` (project-scoped, checked into the repo):**

```json
{
  "mcpServers": {
    "github-ci": {
      "url": "http://127.0.0.1:9444/mcp",
      "type": "http"
    }
  }
}
```

### 4. Start Claude Code

```bash
claude --dangerously-load-development-channels server:github-ci
```

### 5. Register your session filter (once per session)

After Claude Code connects, tell the mux which repo and branch this session is
watching. Paste the following into the Claude Code prompt:

```
Call set_filter with:
- repo: the output of `git remote get-url origin` parsed to owner/repo format
- branch: the output of `git branch --show-current`
```

Or add this to your `~/.claude/CLAUDE.md` so it happens automatically:

```markdown
## GitHub CI Channel — session filter

When the github-ci MCP server connects, immediately call the `set_filter` tool:
1. Run `git remote get-url origin` and parse it to "owner/repo" format
2. Run `git branch --show-current` to get the current branch
3. Call `set_filter(repo="owner/repo", branch="branch-name")`

This ensures you only receive CI/PR notifications relevant to your current work.
```

---

## Event routing

The mux routes each webhook event to sessions whose filter matches:

| Event | Routing branch used |
|---|---|
| `workflow_run` failure | Run's `head_branch` |
| `pull_request` dirty/behind | PR head branch |
| PR review / comment | PR head branch |
| `push` → behind PRs (async) | Each affected PR's head branch |
| Everything else | Broadcast to all sessions for the repo |

Filter matching rules:

| Session filter | Event routing | Match? |
|---|---|---|
| `repo=foo/bar branch=feat/x` | `foo/bar @ feat/x` | ✅ |
| `repo=foo/bar branch=null` | `foo/bar @ feat/x` | ✅ watches all branches |
| `repo=null branch=null` | anything | ✅ wildcard |
| `repo=foo/bar branch=main` | `foo/bar @ feat/x` | ❌ branch mismatch |

When you switch branches, call `set_filter` again (or add a `git checkout`
hook to do it automatically).

---

## Running as a systemd unit

Save as `~/.config/systemd/user/github-ci-mux.service`:

```ini
[Unit]
Description=github-ci-channel mux server
After=network.target

[Service]
# WorkingDirectory is where Bun looks for a .env file at startup.
# Set it to whichever directory holds your .env with GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN.
WorkingDirectory=/path/to/directory/containing/.env
ExecStart=/home/you/.bun/bin/github-ci-mux
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

> Find the binary path with `which github-ci-mux` after a global install (`bun add -g claude-code-github-ci-channel`).
>
> If you are running from a cloned repo instead, replace `ExecStart` with:
> ```
> ExecStart=/home/you/.bun/bin/bun run /path/to/claude-code-github-ci-channel/src/mux.ts
> ```

```bash
systemctl --user daemon-reload
systemctl --user enable --now github-ci-mux
journalctl --user -u github-ci-mux -f   # tail logs
```

The `EnvironmentFile` directive loads your `.env` file — no secrets in the
unit file itself.

---

## Comparison: standalone vs mux

| | Standalone (`src/index.ts`) | Mux (`src/mux.ts`) |
|---|---|---|
| How Claude Code starts it | Subprocess (via `.mcp.json` `command`) | Does not start it — you do |
| Sessions supported | 1 | Unlimited |
| Port conflicts | Yes — second session fails | No — mux owns both ports |
| Per-session routing | N/A | Via `set_filter` tool |
| Secrets | `env` block in `.mcp.json` | `.env` file in repo root |
| Persistent process needed | No | Yes |
| Recommended for | Single terminal, simple setup | Multiple terminals / repos |
