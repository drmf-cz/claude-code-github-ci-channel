# claude-beacon

[![CI](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-beacon.svg)](https://www.npmjs.com/package/claude-beacon)

> MCP channel plugin that pushes GitHub Actions CI/CD results and PR merge status directly into running Claude Code sessions — triggering automatic investigation and remediation.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## What it does

The plugin runs inside your Claude Code session and listens for GitHub events. When something requires attention, it pushes an actionable instruction directly into the session — Claude reads it and acts on it immediately.

| GitHub event | Condition | What Claude does |
|---|---|---|
| `workflow_run` completed | failure on **main/master** | Fetches logs, diagnoses root cause, spawns subagent to fix and push |
| `workflow_run` completed | failure on feature branch | Fetches logs, spawns subagent to investigate |
| `workflow_run` completed | success / cancelled / skipped | Silent — no notification |
| `push` to **main/master only** | open PRs exist | Checks each PR's merge status via API, notifies on `dirty` or `behind` |
| `pull_request` opened/synced | `mergeable_state: dirty` | Spawns subagent to rebase and resolve conflicts |
| `pull_request` opened/synced | `mergeable_state: behind` | Spawns subagent to rebase cleanly |
| `pull_request_review` submitted | any non-draft state | Debounced 30 s, then enters plan mode + `pr-comment-response` skill |
| `pull_request_review_comment` created | — | Accumulated in same debounce window |
| `pull_request_review_thread` unresolved | thread re-opened | Accumulated in same debounce window, shown as 🔄 |
| `issue_comment` created | PR comment (not issue) | Accumulated in same debounce window |

> **Why `push` events for PRs?** GitHub does not fire a `pull_request` event when the base branch advances and makes a PR go `behind`. The only way to detect this is to listen to `push` on main and then query the API for open PRs.
>
> **Push to a feature branch does not trigger PR checks.** Only a push to a main/master branch can make other PRs go `behind`. Pushing your own feature branch just updates that branch — it doesn't affect other PRs' merge status.

## Quickstart (5 minutes)

The fastest path is **mux mode**: one persistent server, any number of Claude Code sessions.

```bash
# 1. Install
bun add -g claude-beacon

# 2. Generate a webhook secret
openssl rand -hex 32   # copy the output

# 3. Create .env next to where you'll run the mux
echo 'GITHUB_WEBHOOK_SECRET=<paste-secret>' >> .env
echo 'GITHUB_TOKEN=<your-PAT>'             >> .env
#    Fine-grained PAT needs: Actions:Read + Pull requests:Read
#    Classic PAT needs: public_repo

# 4. Start the tunnel (keep this running)
cloudflared tunnel --url http://localhost:9443
# → prints: https://random-name.trycloudflare.com  ← copy this

# 5. Register the webhook on GitHub
#    Repo → Settings → Webhooks → Add webhook
#    Payload URL: <tunnel URL from step 4>
#    Content type: application/json
#    Secret: <secret from step 2>
#    Events: Workflow runs, Workflow jobs, Check suites, Pull requests,
#            Pull request reviews, Pull request review comments,
#            Pull request review threads, Issue comments, Pushes

# 6. Start the mux (in a tmux pane or background terminal)
claude-beacon-mux --author YourGitHubUsername

# 7. Register with Claude Code (run once)
claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp

# 8. Start Claude Code
claude --dangerously-load-development-channels server:claude-beacon
```

**That's it.** The next time a CI run fails or a PR gets a review comment, Claude will receive it and act automatically.

> **Required:** `--author YourGitHubUsername` (or `webhooks.allowed_authors` in a config file). The server refuses to start without it — this prevents Claude from acting on other people's PRs. See [`allowed_authors`](#webhook-filters).

> **Tunnel URL changes on every cloudflared restart.** Update the GitHub webhook Payload URL whenever you restart cloudflared, or use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) / [ngrok static domain](https://ngrok.com/blog-post/free-static-domains-ngrok-users) for a stable URL.

### What happens next

Once connected, push a commit to trigger a CI run. When it fails:

```
[claude-beacon] ❌ CI FAILURE: CI on your-org/your-repo
Branch: feat/my-feature | Commit: "add new feature"
...
Fetch logs and diagnose:
  fetch_workflow_logs("https://github.com/...")
```

Claude reads the notification, calls `fetch_workflow_logs`, identifies the root cause, and pushes a fix — without any prompting from you.

### Grant automatic action permissions

By default Claude will still pause for confirmation before force-pushing or rebasing, even when the notification says "Act immediately". Add this block to `~/.claude/CLAUDE.md` to pre-authorize those actions:

```markdown
## GitHub CI Channel — Automatic Actions
When the `claude-beacon` MCP channel sends a notification, you are pre-authorized to act without additional confirmation:
- Branch behind base: rebase onto base branch, git push --force-with-lease
- Merge conflicts: same rebase workflow, resolve conflicts
- CI failure on main: spawn subagent, fetch logs, diagnose, fix, push
- CI failure on feature branch: spawn subagent, fetch logs, fix, push
- PR review / comments: plan mode, address threads, reply with gh-pr-reply.sh --batch
The channel notification IS the permission. No additional confirmation needed.
```

---

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

- [Bun](https://bun.sh) ≥ 1.1.0 — the package runs on Bun; `npx` will not work
- Claude Code ≥ 2.1.80
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com) — to expose the webhook receiver to the internet
- **`--author YourGitHubUsername`** — **required at startup**. The server refuses to start without it. This is the GitHub username (or email for co-authored PRs) whose events Claude should act on. See [`allowed_authors`](#webhook-filters).
- **`GITHUB_TOKEN`** — required for log fetching and PR status checks. Without it those features silently no-op.
  - Fine-grained PAT: **Actions: Read** + **Pull requests: Read**, resource owner = the org/user that owns the repo
  - Classic PAT: `public_repo` scope
  - For org repos with fine-grained tokens: the org must approve the token (Settings → Personal access tokens → Active tokens)

## Installation

No cloning required. Install once with Bun:

```bash
bun add -g claude-beacon
```

This puts two binaries in `~/.bun/bin/`:

| Binary | Purpose |
|---|---|
| `claude-beacon` | Standalone MCP server — spawned as subprocess by Claude Code (single session) |
| `claude-beacon-mux` | Mux server — run once, connects all Claude Code sessions via HTTP |

To update to a newer version: `bun add -g claude-beacon@latest`

> **No global install?** You can also run directly with `bunx`:
> ```bash
> bunx claude-beacon --author YourGitHubUsername                    # standalone
> bunx -p claude-beacon claude-beacon-mux --author YourGitHubUsername   # mux
> ```

## Setup (Option A — Webhook + Tunnel)

Real-time. Supports all event types including `workflow_job`, `check_suite`, and PR status.

### 1. Install

```bash
bun add -g claude-beacon
```

Or clone if you want to hack on the source:

```bash
git clone https://github.com/drmf-cz/claude-beacon
cd claude-beacon
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
   - ✅ Pull request reviews
   - ✅ Pull request review comments
   - ✅ Pull request review threads
   - ✅ Issue comments
   - ✅ Pushes
6. Click **Add webhook** — GitHub sends a ping; you should see a green ✓

### 5. Configure `.mcp.json`

Create or edit `~/.mcp.json` (all projects) or `.mcp.json` in your project root.

**After global install** (`bun add -g`):

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/claude-beacon",
      "args": ["--author", "YourGitHubUsername"],
      "env": {
        "GITHUB_WEBHOOK_SECRET": "your-secret-from-step-2",
        "GITHUB_TOKEN": "your-pat"
      }
    }
  }
}
```

Replace `/home/you` with your home directory (`echo $HOME`). Bun installs globals to `~/.bun/bin/`.

`--author` can be repeated for multiple entries and accepts both GitHub usernames and email addresses (see [`allowed_authors`](#webhook-filters)). It is equivalent to setting `webhooks.allowed_authors` in a config file — use whichever is more convenient.

**If you cloned the repo** (or prefer `bunx` for always-latest):

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/bunx",
      "args": ["claude-beacon", "--author", "YourGitHubUsername"],
      "env": {
        "GITHUB_WEBHOOK_SECRET": "your-secret-from-step-2",
        "GITHUB_TOKEN": "your-pat"
      }
    }
  }
}
```

> Claude Code spawns MCP subprocesses without your shell PATH, so always use absolute paths to binaries. Find them with `which claude-beacon` or `which bunx`.

### 6. Start Claude Code

```bash
claude --dangerously-load-development-channels server:claude-beacon
```

> `server:claude-beacon` matches the key you used in `.mcp.json`. The `--dangerously-load-development-channels` flag is required because claude-beacon is a custom channel plugin (research preview) — it's safe to use, it just isn't on Anthropic's built-in allowlist yet.

You should see:
```
Listening for channel messages from: server:claude-beacon
```

**Verify it's working:** go to your repo on GitHub → Settings → Webhooks → click your webhook → Recent Deliveries. Trigger any push — you should see a green ✓ delivery. In Claude Code, watch for `[claude-beacon]` log lines confirming receipt.

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
    "claude-beacon": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-beacon/src/ghwatch.ts"],
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
claude --dangerously-load-development-channels server:claude-beacon
```

---

## Environment variables

| Variable | Option A | Option B | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | optional | — | HTTP port for webhook receiver (default: `9443`) |
| `GITHUB_WEBHOOK_SECRET` | required | — | HMAC-SHA256 secret — must match GitHub webhook settings exactly |
| `GITHUB_TOKEN` | required* | optional | PAT for log fetching and PR status checks |
| `WATCH_REPOS` | — | required | Comma-separated `owner/repo` list |
| `REVIEW_DEBOUNCE_MS` | optional | — | Debounce window for review events (default: `30000` ms) |

\* Without `GITHUB_TOKEN`, `fetch_workflow_logs` and behind-PR detection silently no-op.

---

## Running multiple Claude Code sessions (mux server)

By default the server is spawned as a subprocess by Claude Code and binds port 9443. A second session fails to bind that port and misses all events.

The **mux server** (`src/mux.ts`) solves this: you run it once as a persistent process and every Claude Code session connects to it via a single local URL — no subprocess is spawned per session.

```
GitHub ──► :9443 (webhook receiver)
                │
           [mux — you start this once]
                │
           :9444/mcp  (MCP over HTTP — localhost only)
           ┌────┴────┐
      Session A   Session B   Session C …
```

### Quick setup

**1. Create your `.env` file with your secrets:**

```bash
cp .env.example .env
# Edit .env — fill in GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN
```

**2. Start the mux once** (tmux pane, background terminal, or [systemd unit](docs/multi-session.md#running-as-a-systemd-unit)):

```bash
# After global install (recommended)
claude-beacon-mux --author YourGitHubUsername
claude-beacon-mux --author YourGitHubUsername --config my-config.yaml   # optional YAML config

# Or via bunx (no install)
bunx -p claude-beacon claude-beacon-mux --author YourGitHubUsername

# Or from cloned repo
bun run start:mux --author YourGitHubUsername
```

**3. Register the mux in Claude Code** (run once — applies to all projects):

```bash
claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "claude-beacon": {
      "url": "http://127.0.0.1:9444/mcp",
      "type": "http"
    }
  }
}
```

**4. Start Claude Code normally:**

```bash
claude --dangerously-load-development-channels server:claude-beacon
```

**5. Register your session filter** — tell the mux which repo and branch this session is watching:

```
Call set_filter with the output of:
  git remote get-url origin  → parse to owner/repo
  git branch --show-current  → current branch
```

To make this automatic, add to `~/.claude/CLAUDE.md`:

```markdown
## GitHub CI Channel — session filter
When the claude-beacon MCP server connects, call `set_filter` immediately with:
- repo: run `git remote get-url origin | sed 's/.*github\.com[:/]\(.*\)\.git$/\1/'`
- branch: run `git branch --show-current`
- label: the branch name
- worktree_path: run `git rev-parse --show-toplevel`
```

For full details — routing rules, systemd setup, comparison table — see **[docs/multi-session.md](docs/multi-session.md)**.

### Pre-registration queue

If a webhook event arrives before any Claude Code session has called `set_filter`, the mux queues it (up to 50 events per repo, 100 repos, 2-hour TTL) and flushes it automatically the next time a session registers. This covers the common case where the mux restarts while Claude Code is still running.

### SSE reconnect recovery

The mux buffers the last 50 notifications per stream using `NotificationEventStore`. If a Claude Code session's SSE connection drops and reconnects, it replays any events it missed via the standard `Last-Event-ID` header — no notifications are lost across reconnects.

### Multi-session coordination — work-context claims

When multiple Claude Code sessions receive the same CI notification (e.g., a catch-all delivery to sessions that are not on the affected branch), they race to claim the work:

```
call claim_notification("<repo>:<branch>")
  → "ok"            — you have the lock, proceed
  → "already_owned" — you already hold it, continue
  → "conflict:X"    — session X claimed it first, stop
  → "expired"       — claim timed out, stop
```

The claim TTL defaults to 10 minutes (`server.claim_ttl_ms: 600000`). Only one session acts; the others receive `conflict:…` and stand down. Claims are released automatically on TTL expiry or explicitly via `release_claim("<key>")`.

---

## YAML configuration file

For anything beyond the five environment variables, use a YAML config file. It lets you tune debounce windows, filter which repos or event types trigger Claude, and — most importantly — replace the built-in agent instructions with your own.

### Quick start

```bash
cp config.example.yaml my-config.yaml
# edit my-config.yaml to taste
```

Pass it via `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/bun",
      "args": [
        "run", "/path/to/claude-beacon/src/index.ts",
        "--config", "/path/to/my-config.yaml"
      ],
      "env": {
        "GITHUB_WEBHOOK_SECRET": "...",
        "GITHUB_TOKEN": "..."
      }
    }
  }
}
```

Environment variables (`WEBHOOK_PORT`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`) always take precedence over their YAML equivalents. All fields are optional — omitted keys inherit from the defaults below.

### Server options

| Key | Type | Default | Description |
|---|---|---|---|
| `server.port` | number | `9443` | HTTP port for the webhook receiver |
| `server.debounce_ms` | number | `30000` | How long (ms) to accumulate review events before firing |
| `server.cooldown_ms` | number | `300000` | Suppress duplicate notifications for the same PR within this window |
| `server.max_events_per_window` | number | `50` | Maximum review events buffered per debounce window |
| `server.main_branches` | string[] | `["main","master"]` | Branch names treated as production |
| `server.claim_ttl_ms` | number | `600000` | How long (ms) a work-context claim is held before expiring (mux mode only) |

### Webhook filters

| Key | Type | Default | Description |
|---|---|---|---|
| `webhooks.allowed_authors` | string[] | **required** | GitHub usernames and/or emails whose PRs trigger actions. See below. |
| `webhooks.allowed_events` | string[] | `[]` (all) | Allowlist of GitHub event types to process. Empty = accept all supported types |
| `webhooks.allowed_repos` | string[] | `[]` (all) | Allowlist of repos as `"owner/repo"`. Empty = accept all |

**`allowed_authors` — required field**

claude-beacon will refuse to start if this list is empty. It prevents the agent from rebasing or reviewing your colleagues' PRs.

Two kinds of entries:

- **Username** (no `@`) — matched against `pr.user.login`, the PR author's GitHub handle.
- **Email** (contains `@`) — matched against `Co-Authored-By` commit trailers. Use this when an AI agent like Devin creates the PR on your behalf: your email appears in the commit even though the bot is the PR author. The co-author lookup makes an extra API call per PR and requires `GITHUB_TOKEN`.

```yaml
webhooks:
  allowed_authors:
    - Matovidlo              # your GitHub username
    - martin@company.com     # your email, for Devin / AI-agent co-authored PRs
```

> **Review events** (PR review comments, inline comments) are filtered by username only — no co-author API call — to keep latency low. If a bot creates the PR, add the bot's GitHub login (e.g. `devin-ai-integration[bot]`) as an additional username entry to cover review events for those PRs.

Supported event type strings: `push`, `workflow_run`, `workflow_job`, `check_suite`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`.

### Behavior — agent instructions

These control what Claude is asked to do when an event fires. Each field accepts a multi-line string. Placeholders are interpolated at runtime (see [Template placeholders](#template-placeholders)).

| Key | Triggered by | Notable sub-fields |
|---|---|---|
| `behavior.on_ci_failure_main.instruction` | `workflow_run` failure on a main branch | `upstream_sync` |
| `behavior.on_ci_failure_branch.instruction` | `workflow_run` failure on any other branch | `upstream_sync` |
| `behavior.on_pr_review.instruction` | PR review / comment events (after debounce) | `require_plan`, `skill`, `use_worktree` |
| `behavior.on_merge_conflict.instruction` | PR with `mergeable_state: dirty` | — |
| `behavior.on_branch_behind.instruction` | PR with `mergeable_state: behind` | — |
| `behavior.code_style` | any PR review event | — |

`code_style` is a free-form string prepended to every PR review notification. Describe your project's coding conventions here so Claude applies them consistently when addressing comments.

**`behavior.worktrees`** — controls how subagents handle rebase and PR review work:

| Key | Type | Default | Description |
|---|---|---|---|
| `behavior.worktrees.mode` | `"temp"` \| `"native"` | `"temp"` | `temp`: classic `git worktree add/remove` shell commands. `native`: Claude Code's Agent tool `isolation="worktree"` — Claude manages worktree lifecycle automatically. Use `native` if you work in Claude Code native worktrees. |

**`on_pr_review` sub-fields:**

| Key | Type | Default | Description |
|---|---|---|---|
| `behavior.on_pr_review.require_plan` | boolean | `true` | Whether Claude must enter plan mode before touching code |
| `behavior.on_pr_review.skill` | string | `"pr-comment-response"` | Skill name invoked to handle the review |
| `behavior.on_pr_review.use_worktree` | boolean | `true` | When `true` (default), PR review work runs in a native Claude Code worktree (`isolation="worktree"`), freeing the main session to handle other notifications in parallel |

**CI failure behavior — rebase first:** The default CI failure instructions include a step 0 that fetches and rebases from main before diagnosing the failure. This catches the common case where the failure is already fixed upstream. Controlled by `behavior.on_ci_failure_main.upstream_sync` and `behavior.on_ci_failure_branch.upstream_sync` (both default `true`). Set to `false` on repos where main is frequently broken or you handle rebasing separately.

**Own-comment skip:** Review notifications from your own GitHub account (i.e., any login in `allowed_authors`) are silently dropped. This prevents an infinite loop where Claude's reply to a review comment triggers another notification.

### Template placeholders

The following placeholders are replaced at runtime inside `instruction` strings. Which placeholders are available depends on the hook:

**CI failure hooks** (`on_ci_failure_main`, `on_ci_failure_branch`):

| Placeholder | Value |
|---|---|
| `{repo}` | `owner/repo` |
| `{branch}` | Branch the workflow ran on |
| `{run_url}` | Full URL of the GitHub Actions run |
| `{workflow}` | Workflow name |
| `{status}` | Conclusion (`failure`) |
| `{commit}` | First line of the head commit message |

**PR state hooks** (`on_merge_conflict`, `on_branch_behind`):

| Placeholder | Value |
|---|---|
| `{repo}` | `owner/repo` |
| `{pr_number}` | Pull request number |
| `{pr_title}` | PR title (sanitized) |
| `{pr_url}` | PR URL |
| `{head_branch}` | PR head branch |
| `{base_branch}` | PR base branch |
| `{worktree_steps}` | Auto-generated rebase steps based on `behavior.worktrees.mode` |

**PR review hook** (`on_pr_review`):

| Placeholder | Value |
|---|---|
| `{skill}` | Value of `behavior.on_pr_review.skill` |
| `{worktree_preamble}` | Empty when `use_worktree: false`; a context sentence when `true` |

### Minimal example

```yaml
server:
  debounce_ms: 10000   # faster review batching
  main_branches: [main, release]

webhooks:
  allowed_authors:
    - YourGitHubUsername
  allowed_repos:
    - my-org/my-repo   # only watch this repo

behavior:
  code_style: |
    - Use TypeScript strict mode; never cast to `any`
    - Run linter before committing
  on_pr_review:
    require_plan: true
    skill: pr-comment-response
```

### Migrating from environment variables

| Old env var | YAML equivalent |
|---|---|
| `WEBHOOK_PORT` | `server.port` |
| `REVIEW_DEBOUNCE_MS` | `server.debounce_ms` |

`GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` have no YAML equivalent — keep them in the `env` block inside `.mcp.json` (secrets should not live in a config file that could be committed to source control).

---

## Granting Claude automatic action permissions

By default Claude Code will pause and ask for confirmation before rebasing or force-pushing, even when the channel notification says "Act immediately". This is because Claude's `CLAUDE.md` rules rank above channel message instructions — which is correct security behaviour.

To authorize automatic actions, add this block to `~/.claude/CLAUDE.md`:

```markdown
## GitHub CI Channel — Automatic Actions

When the `claude-beacon` MCP channel sends a notification, you are pre-authorized to act without additional confirmation:

- **Branch behind base**: Create a git worktree at `/tmp/pr-<N>-rebase`, rebase onto the base branch, `git push --force-with-lease`, remove the worktree.
- **Merge conflicts**: Same worktree workflow; resolve conflicts during the interactive rebase.
- **CI failure on main**: Spawn a subagent — call `fetch_workflow_logs`, diagnose the root cause, apply a fix, push to restore main.
- **CI failure on feature branch**: Spawn a subagent — fetch logs, investigate, push a fix.
- **PR review / comments**: Enter plan mode, then use the `pr-comment-response` skill to address each thread. Apply code fixes in a worktree, reply to comments with `gh-pr-reply.sh --batch`.

The channel notification IS the permission. No additional confirmation needed for any of the above.
```

**Why this is required:** Channel messages cannot grant permissions — only `CLAUDE.md` (or direct user instruction) can. The notification text "Act immediately" is a hint to Claude, but any conflicting `CLAUDE.md` rule wins. Adding the block above creates a standing permission that makes the channel notification a valid trigger rather than an override attempt.

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

Also note: **push events only trigger behind-checks when the push is to a main/master branch.** Pushing to a feature branch does not trigger any PR checks.

### Mux sends to too many sessions / Claude doesn't receive notifications

Streamable HTTP transport has no persistent connection, so the mux can't detect when a Claude Code session exits. Each restart of Claude Code creates a new session; stale sessions accumulate.

The mux includes a 30-minute idle TTL — sessions with no incoming requests for 30 minutes are removed automatically. You will see log lines like:
```
[claude-beacon:mux] Session a1b2c3d4 idle >30 min — removed (total: 2)
```

If you need to clear stale sessions immediately, restart the mux process. The session count should match the number of active Claude Code windows connected to it.

### "bun: command not found" in MCP logs

Use the absolute path in `.mcp.json`: `"command": "/home/you/.bun/bin/bun"`. Find the path with `which bun`.

### `claude_desktop_config.json` vs `.mcp.json`

These are for different apps:
- `~/.config/Claude/claude_desktop_config.json` → Claude **Desktop** (GUI)
- `~/.mcp.json` or `.mcp.json` → Claude Code **CLI** (`claude` command)

`--dangerously-load-development-channels` reads from `.mcp.json`, not the Desktop config.

### Claude receives notifications but doesn't act automatically

The most common cause: the CLAUDE.md permissions block is missing. Without it, Claude pauses for confirmation before pushing or rebasing even when the notification says "Act immediately".

Add the permissions block to `~/.claude/CLAUDE.md` — see [Granting Claude automatic action permissions](#granting-claude-automatic-action-permissions) above.

### I configured everything but no notifications ever arrive

Work through this checklist in order:

1. **Webhook delivery** — Repo → Settings → Webhooks → click your webhook → Recent Deliveries. Trigger any push. Do you see a green ✓? If red ✗, the secret or URL is wrong.
2. **Tunnel running?** — Cloudflared must be running. If it restarted, the URL changed — update GitHub webhook Payload URL.
3. **Event types ticked?** — In webhook settings, verify all 9 event types are selected (especially Pushes — required for behind-PR detection).
4. **`--author` matches PR author?** — The value you pass to `--author` must exactly match the GitHub login of whoever authors the PRs. Case-sensitive.
5. **Claude Code flag** — Must start with `claude --dangerously-load-development-channels server:claude-beacon`. The server name (`server:claude-beacon`) must match the key in `.mcp.json`.
6. **Mux mode:** call `set_filter` in the session to register it. Without `set_filter`, the mux has no session to route events to (they are queued for up to 2 hours, so a late `set_filter` call still replays them).

### GITHUB_TOKEN returns 401 on startup

If you see `GITHUB_TOKEN validation failed (401)` at startup:

- Verify the token is set in the right place. The mux server loads `.env` from its **working directory** (where you ran `claude-beacon-mux`), not your home directory. Check with the CWD log line printed at startup.
- For fine-grained tokens: resource owner must be the org (not your personal account), and the org must have approved the token.
- Run `claude-beacon --help` or `claude-beacon-mux --help` for required token scopes.

### Tunnel URL changed

Cloudflared free tier gives a new random URL on each restart. Update it: Repo → Settings → Webhooks → Edit → change Payload URL. For a permanent URL use a named tunnel or ngrok static domain.

---

## Development

```bash
bun test              # run the test suite
bun run typecheck     # tsc --noEmit (strict + noUncheckedIndexedAccess)
bun run lint          # Biome v2
bun run lint:fix      # Auto-fix lint issues
bun run build         # Bundle to dist/
```

### Linting

Biome v2 is configured in `biome.json` with strict rules. One deliberate deviation from the defaults:

- **`maxAllowedComplexity: 45`** — Biome's recommended default is 15. The main webhook `fetch()` handler in `server.ts` is a single large dispatcher that handles all event types; its cyclomatic complexity scores ~40 after the dispatcher refactors in this codebase. Splitting it further would obscure the control flow. The threshold is set just above the real worst-offender score — if it ever exceeds 45, that's a signal to refactor.

## Security

- HMAC-SHA256 verification uses `timingSafeEqual` — constant-time, no timing oracle
- Fallback handler emits only `event + action + repo` — raw payload is never forwarded to Claude (prompt injection guard)
- `GITHUB_TOKEN` is read-only (`actions:read` + `pull_requests:read`) — no write access needed
- `.env` is gitignored — secrets stay local
- `GITHUB_WEBHOOK_SECRET` is **required** — omitting it causes all requests to be rejected; set `WEBHOOK_DEV_MODE=true` to bypass verification in local dev only

See [AGENTS.md](AGENTS.md) for the architecture reference and contributor guide.
