# claude-beacon

[![CI](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-beacon.svg)](https://www.npmjs.com/package/claude-beacon)

> MCP channel plugin that pushes GitHub Actions CI/CD results and PR events directly into running Claude Code sessions — triggering automatic investigation and remediation.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## What it does

| GitHub event | Condition | What Claude does |
|---|---|---|
| `workflow_run` completed | failure on **main/master** | Fetches logs, diagnoses root cause, spawns subagent to fix and push |
| `workflow_run` completed | failure on feature branch | Fetches logs, spawns subagent to investigate and fix |
| `push` to **main/master** | open PRs exist | Checks each PR's merge status; notifies on `dirty` or `behind` |
| `pull_request` | `mergeable_state: dirty` | Spawns subagent to rebase and resolve conflicts |
| `pull_request` | `mergeable_state: behind` | Spawns subagent to rebase cleanly |
| `pull_request_review` submitted | any non-APPROVED state | Debounced 30 s, then plan mode + `pr-comment-response` skill |
| `pull_request_review_comment` / `issue_comment` | — | Accumulated in the same debounce window |
| `pull_request` opened/ready | opt-in (`on_pr_opened.enabled`) | Notifies on new PRs opened or marked ready for review |
| `pull_request_review` APPROVED | opt-in (`on_pr_approved.enabled`) | Separate handler — e.g. auto-merge trigger |
| `dependabot_alert` created | opt-in (`on_dependabot_alert.enabled`) | Notifies about CVE — review and bump the dependency |
| `code_scanning_alert` created | opt-in (`on_code_scanning_alert.enabled`) | Notifies about SAST finding — review and apply a fix |

> `push` events on main are the only way to detect PRs going `behind` — GitHub doesn't fire a `pull_request` event when the base branch advances. Pushing to a feature branch does **not** trigger PR checks.

---

## Quickstart

The fastest path is **mux mode**: one persistent server, any number of Claude Code sessions.

**Requirements:** [Bun](https://bun.sh) ≥ 1.1.0 · Claude Code ≥ 2.1.80 · [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com)

### 1. Install

```bash
bun add -g claude-beacon
```

### 2. Set up secrets

```bash
openssl rand -hex 32   # generate a webhook secret — copy the output

echo 'GITHUB_WEBHOOK_SECRET=<paste-secret>' >> .env
echo 'GITHUB_TOKEN=<your-PAT>'             >> .env
```

`GITHUB_TOKEN` scopes: fine-grained → **Actions: Read** + **Pull requests: Read**; classic → `public_repo`.

### 3. Start the tunnel

```bash
cloudflared tunnel --url http://localhost:9443
# → prints: https://random-name.trycloudflare.com  ← copy this URL
```

Keep the tunnel running. The URL changes on restart — update the GitHub webhook Payload URL when that happens. For a stable URL: [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) or [ngrok static domain](https://ngrok.com/blog-post/free-static-domains-ngrok-users).

### 4. Register the webhook on GitHub

Repo → **Settings → Webhooks → Add webhook**:
- **Payload URL** — paste the tunnel URL
- **Content type** — `application/json`
- **Secret** — paste the webhook secret from step 2
- **Events** — select individually: Workflow runs, Workflow jobs, Check suites, Pull requests, Pull request reviews, Pull request review comments, Pull request review threads, Issue comments, Pushes

### 5. Start the mux

```bash
claude-beacon-mux --author YourGitHubUsername
```

> **`--author` is required.** The server refuses to start without it — it prevents Claude from acting on other people's PRs. See [`allowed_authors`](#allowed_authors-required).

Keep this running in a tmux pane or background terminal. See [docs/multi-session.md](docs/multi-session.md) for systemd setup.

### 6. Connect Claude Code to the mux

```bash
claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp
```

### 7. Start Claude Code

```bash
claude --dangerously-load-development-channels server:claude-beacon
```

You should see: `Listening for channel messages from: server:claude-beacon`

**Verify:** Repo → Settings → Webhooks → Recent Deliveries. Trigger a push — green ✓ means it's working. In Claude, watch for `[claude-beacon]` log lines.

### 8. Authorize automatic actions

By default Claude pauses for confirmation before force-pushing or rebasing, even when the notification says "Act immediately". Add this block to `~/.claude/CLAUDE.md` to grant standing permission:

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

### 9. Register the session filter

The mux routes events by repo and branch. Add this to `~/.claude/CLAUDE.md` so Claude registers automatically on session start:

```markdown
## GitHub CI Channel — session filter
When the claude-beacon MCP server connects, call `set_filter` immediately with:
- repo: run `git remote get-url origin` and parse to owner/repo
- branch: run `git branch --show-current`
- label: same as branch
- worktree_path: run `git rev-parse --show-toplevel`
```

> **Optional — Stop hook:** When Claude exits while holding a work claim, other sessions wait up to 10 minutes before taking over. Add a `Stop` hook to `~/.claude/settings.json` to release the claim immediately on exit:
>
> ```json
> {
>   "hooks": {
>     "Stop": [{"matcher": "", "hooks": [{"type": "command",
>       "command": "claim=$(cat ~/.claude/beacon-active-claim 2>/dev/null) && [ -n \"$claim\" ] && curl -sf -X POST http://localhost:9444/release-claim -H 'Content-Type: application/json' -d \"{\\\"claim_key\\\":\\\"$claim\\\"}\" && rm -f ~/.claude/beacon-active-claim || true"
>     }]}]
>   }
> }
> ```

---

## Other deployment modes

### Standalone (single Claude session)

If you only ever run one Claude Code window, skip the mux and let Claude Code spawn the server as a subprocess. Add to `~/.mcp.json` or `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/claude-beacon",
      "args": ["--author", "YourGitHubUsername"],
      "env": {
        "GITHUB_WEBHOOK_SECRET": "your-webhook-secret",
        "GITHUB_TOKEN": "your-pat"
      }
    }
  }
}
```

Use absolute paths (`echo $HOME`, `which claude-beacon`). Follow Quickstart steps 1–4 and 7–9; skip steps 5–6.

### CLI Events watcher (no tunnel)

Polls the [GitHub Events API](https://docs.github.com/en/rest/activity/events) using your existing `gh` CLI session — no tunnel or webhook config needed.

Trade-offs: ~30–60 s latency · `WorkflowRunEvent` only (no PR or job events) · no behind-PR detection.

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-beacon/src/ghwatch.ts"],
      "env": { "WATCH_REPOS": "owner/repo1,owner/repo2" }
    }
  }
}
```

---

## Multi-session coordination

When multiple Claude Code sessions receive the same notification, the claim API ensures only one acts:

```
claim_notification("<repo>:<branch>")
  → "ok"            — you have the lock, proceed
  → "already_owned" — you already hold it, continue
  → "conflict:X"    — session X claimed it first, stop
  → "expired"       — claim timed out, stop
```

Claims expire after 10 minutes (`server.claim_ttl_ms`). Release explicitly with `release_claim("<key>")` or automatically via the Stop hook (see [Quickstart step 9](#9-register-the-session-filter)).

If a webhook arrives before any session has called `set_filter`, the mux queues it (up to 50 events per repo, 2-hour TTL) and flushes it when a session registers.

---

## Configuration

All settings are optional — the defaults work for most setups. Pass a YAML file with `--config my-config.yaml` (or via `.mcp.json` args). Environment variables (`GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `WEBHOOK_PORT`, `REVIEW_DEBOUNCE_MS`) always override YAML.

```bash
cp config.example.yaml my-config.yaml   # start from the annotated template
claude-beacon-mux --author YourGitHubUsername --config my-config.yaml
```

### `allowed_authors` (required) {#allowed_authors-required}

claude-beacon refuses to start without at least one entry. Two kinds:

- **Username** (no `@`) — matched against `pr.user.login`, the PR author's GitHub handle.
- **Email** (contains `@`) — matched against `Co-Authored-By` commit trailers. Use when an AI agent (Devin, etc.) creates the PR on your behalf.

```yaml
webhooks:
  allowed_authors:
    - YourGitHubUsername
    - you@company.com   # for AI-agent co-authored PRs
```

### Server options

| Key | Default | Description |
|---|---|---|
| `server.port` | `9443` | HTTP port for the webhook receiver |
| `server.debounce_ms` | `30000` | Accumulate review events for this many ms before firing |
| `server.cooldown_ms` | `300000` | Suppress duplicate notifications for the same PR |
| `server.max_events_per_window` | `50` | Maximum review events buffered per debounce window |
| `server.main_branches` | `["main","master"]` | Branch names treated as production |
| `server.claim_ttl_ms` | `600000` | How long a work-context claim is held before expiring |

### Webhook filters

| Key | Default | Description |
|---|---|---|
| `webhooks.allowed_authors` | **required** | GitHub usernames and/or emails whose PRs trigger actions |
| `webhooks.allowed_events` | `[]` (all) | Allowlist of GitHub event types. Empty = accept all |
| `webhooks.allowed_repos` | `[]` (all) | Allowlist of repos as `"owner/repo"`. Empty = accept all |

### Behavior hooks

Each hook has an `instruction` template with `{placeholder}` substitution. Opt-in hooks default to `enabled: false`.

| Key | Triggered by | Flags |
|---|---|---|
| `behavior.on_ci_failure_main` | `workflow_run` failure on main | `upstream_sync`, `use_agent` |
| `behavior.on_ci_failure_branch` | `workflow_run` failure on feature branch | `upstream_sync`, `use_agent` |
| `behavior.on_pr_review` | PR review / comment events (debounced) | `require_plan`, `skill`, `use_worktree` |
| `behavior.on_merge_conflict` | PR with `mergeable_state: dirty` | — |
| `behavior.on_branch_behind` | PR with `mergeable_state: behind` | — |
| `behavior.on_pr_opened` | PR opened / ready for review | `enabled` (default `false`) |
| `behavior.on_pr_approved` | APPROVED review submitted | `enabled` (default `false`) |
| `behavior.on_dependabot_alert` | Dependabot CVE alert | `enabled` (default `false`), `min_severity` |
| `behavior.on_code_scanning_alert` | CodeQL / SAST alert | `enabled` (default `false`), `min_severity` |

`behavior.code_style` — free-form string prepended to every PR review notification. Describe your project's coding conventions here.

**Notable flags:**
- `use_agent` — `true` (default) spawns a subagent to fix CI, keeping the main session free. Set `false` to act inline.
- `upstream_sync` — `true` (default) rebases from main before diagnosing. Set `false` if main is frequently broken.
- `behavior.worktrees.mode` — `"temp"` (default, shell `git worktree add/remove`) or `"native"` (Claude Code `isolation="worktree"`).
- `behavior.worktrees.base_dir` — base directory for temporary worktrees (default `/tmp`). Path: `{base_dir}/{repo}-pr-{N}-rebase`.

> Security alert hooks broadcast to **all sessions** registered for the repo. Enable only on the single instance responsible for security triage to avoid multiple sessions racing on the same CVE.

### Template placeholders

| Placeholder | Available in |
|---|---|
| `{repo}` | all hooks |
| `{branch}` | CI failure hooks, code scanning |
| `{run_url}`, `{workflow}`, `{status}`, `{commit}` | CI failure hooks |
| `{use_agent_preamble}` | CI failure hooks (`use_agent` toggle) |
| `{health_check_step}` | CI failure hooks (`upstream_sync` toggle) |
| `{pr_number}`, `{pr_title}`, `{pr_url}` | PR state, on_pr_opened, on_pr_approved |
| `{head_branch}`, `{base_branch}` | PR state, on_pr_opened |
| `{worktree_steps}` | PR state (auto-generated rebase commands) |
| `{skill}`, `{worktree_preamble}` | on_pr_review |
| `{author}` | on_pr_opened |
| `{reviewer}` | on_pr_approved |
| `{cve}`, `{package}`, `{patched_version}` | on_dependabot_alert |
| `{rule}`, `{tool}` | on_code_scanning_alert |
| `{severity}`, `{alert_url}` | both security hooks |

---

## Troubleshooting

**MCP shows red / "Failed to reconnect"**  
Port 9443 is held by a previous session. Run `lsof -i :9443`, kill the PID, restart Claude Code.

**401 Unauthorized on webhooks**  
Secret mismatch. Check `GITHUB_WEBHOOK_SECRET` in `.mcp.json` exactly matches GitHub. A `.env` in the repo directory can shadow it — delete it or make both match.

**No notification when a PR falls behind**  
Ensure **Pushes** is ticked in GitHub webhook events and `GITHUB_TOKEN` is set. Note: only pushes to main/master trigger PR checks, not pushes to feature branches.

**Mux sends to too many sessions**  
Stale sessions auto-expire after 30 minutes of inactivity. Restart the mux to clear them immediately.

**"bun: command not found" in MCP logs**  
Use the absolute path in `.mcp.json`: `"command": "/home/you/.bun/bin/bun"`. Find with `which bun`.

**`claude_desktop_config.json` vs `.mcp.json`**  
`~/.config/Claude/claude_desktop_config.json` is for Claude Desktop. `~/.mcp.json` / `.mcp.json` is for Claude Code CLI. `--dangerously-load-development-channels` reads from `.mcp.json`.

**Claude receives notifications but doesn't act automatically**  
The CLAUDE.md permissions block is missing — add it as described in [Quickstart step 8](#8-authorize-automatic-actions).

**No notifications ever arrive — checklist**
1. Webhook Recent Deliveries → green ✓? If not, secret or URL is wrong.
2. Tunnel still running? Restart = new URL → update GitHub Payload URL.
3. All 9 event types ticked in webhook settings?
4. `--author` exactly matches the GitHub login of the PR author (case-sensitive).
5. Claude Code started with `--dangerously-load-development-channels server:claude-beacon`.
6. In mux mode: `set_filter` called in the session?

**GITHUB_TOKEN 401 on startup**  
The mux loads `.env` from its working directory, not your home directory. Confirm via the CWD log line at startup. For fine-grained tokens: resource owner must be the org, and the org must have approved the token.

---

## Development

```bash
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # Biome v2
bun run build       # bundle to dist/
```

**Security:** HMAC-SHA256 verification uses `timingSafeEqual` (constant-time). Raw payloads are never forwarded to Claude — only sanitized fields reach the notification. `GITHUB_TOKEN` is read-only. `GITHUB_WEBHOOK_SECRET` is required; set `WEBHOOK_DEV_MODE=true` to bypass in local dev only.

See [AGENTS.md](AGENTS.md) for the architecture reference and contributor guide.
