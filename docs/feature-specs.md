# Feature Specifications — claude-beacon

Detailed delivery specs for the five highest-impact features identified in the v1.4.0 quality review.
Each spec covers what is delivered, how it works end-to-end, and what is technically required to build it.

---

## Feature 1 — Claude Code startup hooks (auto `set_filter`)

### Problem

In mux mode every session must manually call `set_filter(repo, branch, label, worktree_path)` after
connecting. If the developer forgets, the mux has no registered session and all notifications are
queued but never delivered (or delivered late when the developer eventually calls `set_filter`).
This is the single most common cause of "nothing fires" reports.

### What is delivered

When a Claude Code session connects to the mux, `set_filter` is called automatically with the
correct repo, branch, and worktree path — without any manual action from the developer.

The developer experience after this feature ships:

1. Start Claude Code in any repo directory
2. Notifications arrive immediately — no `set_filter` call needed

### How it works

Claude Code supports user-defined **hooks** — shell commands that run on lifecycle events. The
relevant hook is `UserPromptSubmit` (fires when the session starts processing its first prompt)
or a startup hook documented in Claude Code ≥ 2.x.

The hook script reads `git` context from the current directory and calls `set_filter` via the MCP
tool:

```bash
# ~/.claude/hooks/startup-set-filter.sh
#!/bin/bash
REPO=$(git remote get-url origin 2>/dev/null \
  | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')
BRANCH=$(git branch --show-current 2>/dev/null)
WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null)

if [ -n "$REPO" ] && [ -n "$BRANCH" ]; then
  # Claude Code hook output is fed back into the session as a tool call
  echo "{\"tool\":\"set_filter\",\"args\":{\"repo\":\"$REPO\",\"branch\":\"$BRANCH\",\"label\":\"$BRANCH\",\"worktree_path\":\"$WORKTREE\"}}"
fi
```

Alternatively (and more reliably), the CLAUDE.md instruction approach already works today — the
hook just automates what CLAUDE.md currently asks the developer to do manually:

```markdown
<!-- ~/.claude/CLAUDE.md — existing workaround, still required until hooks land -->
## Session startup — REQUIRED
On every session start, call set_filter immediately:
  set_filter(repo=<git remote>, branch=<current branch>, ...)
```

**Server-side change required (none for basic case):** `set_filter` already handles late
registration and queue flushing (v1.4.0). The hook approach is purely client-side config.

**Server-side change for proactive delivery:** The mux could expose an MCP resource or prompt
that Claude Code reads on initialization, which contains the `set_filter` invocation. This would
work without a hook:

```typescript
// src/mux.ts — inside createSessionServer()
server.resource(
  "startup-instructions",
  "claude-beacon://startup",
  async () => ({
    contents: [{
      uri: "claude-beacon://startup",
      mimeType: "text/plain",
      text: "Call set_filter(repo, branch, label, worktree_path) immediately to register this session."
    }]
  })
);
```

### What is needed to build it

**Option A — Pure docs/config (no code change, works today):**
- Document the `~/.claude/CLAUDE.md` approach more prominently (already done in v1.4.0 CLAUDE.md)
- Add a ready-to-paste hook script to `docs/` for users on Claude Code versions that support hooks

**Option B — MCP resource (recommended, small code change):**
- In `createMcpServer()` (`src/server.ts`) and `createSessionServer()` (`src/mux.ts`), register an
  MCP resource at `claude-beacon://startup` that returns the `set_filter` invocation instruction
- Claude Code reads MCP resources on session init — this triggers the call without any CLAUDE.md entry

**Files to change:** `src/server.ts:811` (`createMcpServer`), `src/mux.ts:369` (`createSessionServer`)  
**New dependency:** None  
**Test:** Add a test verifying the resource is returned with the correct content

---

## Feature 2 — MCP status line

### Problem

The developer has no real-time indicator that their session is registered, that a claim is held, or
how many notifications are pending. They must check mux logs manually. In a busy session this causes
anxiety: "did that notification actually reach me? Am I still registered?"

### What is delivered

A persistent status indicator visible in the Claude Code UI that shows:

```
claude-beacon  ✓ registered · main  |  claim: owner/repo:feat/x (4m left)
claude-beacon  ✓ registered · main  |  no claim held
claude-beacon  ✗ not registered — call set_filter
```

Updates live as state changes (on `set_filter` call, on claim/release, on TTL expiry).

### How it works

Claude Code exposes an MCP extension for status line content. The MCP server sends a notification
to update the status line text whenever state changes:

```typescript
// Hypothetical MCP notification (check Claude Code SDK for exact method name)
await server.sendNotification("claude/statusLine", {
  text: "✓ registered · main | no claim held"
});
```

The status line is updated at these events:
- `set_filter` called successfully → `✓ registered · {branch}`
- `claim_notification` → `ok` → `claim: {claim_key} ({ttl_remaining}m left)`
- `release_claim` → `✓ registered · {branch} | no claim held`
- Session idle TTL expires → `✗ not registered`
- Claim TTL expires → `✓ registered · {branch} | no claim held`

### What is needed to build it

1. **Verify Claude Code SDK support:** Check `@modelcontextprotocol/sdk` for status line notification
   method. As of v1.4.0 this is not yet confirmed available — check the SDK changelog and
   `notifications/` method list.

2. **If available**, add status state to `SessionEntry` in `src/mux.ts`:
   ```typescript
   interface SessionEntry {
     // ... existing fields ...
     statusText: string;  // current status line content
   }
   ```

3. **Helper to send status update** (call after set_filter, claim, release):
   ```typescript
   function updateStatusLine(entry: SessionEntry, text: string): void {
     entry.statusText = text;
     void entry.server.sendNotification("claude/statusLine", { text });
   }
   ```

4. **Wire into set_filter handler** (`src/mux.ts:380`), `claim_notification` handler, and
   `release_claim` handler.

5. **TTL expiry cleanup** — when the claim TTL timer fires in `workClaims`, call `updateStatusLine`
   to clear the claim indicator.

**Files to change:** `src/mux.ts` (SessionEntry interface, set_filter, claim, release handlers)  
**New dependency:** None (uses existing MCP server instance)  
**Fallback:** If status line notifications aren't supported yet, surface the same info via an MCP
resource that Claude can query: `claude-beacon://status` → returns current session state as text.

---

## Feature 3 — `rerun_workflow` MCP tool

### Problem

When CI fails, Claude fetches the logs, diagnoses the cause, applies a fix, and pushes. But there is
currently no way to trigger a workflow rerun from within the session. Claude must tell the developer
to click "Re-run failed jobs" on GitHub, which breaks the automation loop.

### What is delivered

A new MCP tool `rerun_workflow` that triggers a GitHub Actions rerun:

```
Tool: rerun_workflow
Input: run_url (string) — same URL format as fetch_workflow_logs
       failed_only (boolean, optional, default: true) — rerun only failed jobs

Returns: "Rerun triggered for run #1234 in owner/repo" on success
         Error message on failure (401, 403, run not in re-runnable state)
```

Typical flow after this ships:
1. CI failure notification arrives
2. Claude calls `fetch_workflow_logs(run_url)` → reads error
3. Claude applies fix and pushes
4. Claude calls `rerun_workflow(run_url)` → triggers GitHub to pick up the new commit
5. Notification arrives when rerun completes

### How it works

GitHub API endpoint: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`  
For failed jobs only: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`

Required token scope: `Actions: Write` (fine-grained) or `repo` (classic PAT).  
This is a **write** scope — it must be explicitly documented and the default GITHUB_TOKEN advice
must be updated to mention it.

```typescript
// src/server.ts — inside createMcpServer(), after fetch_workflow_logs tool

mcp.tool(
  "rerun_workflow",
  "Trigger a GitHub Actions workflow rerun. Call after pushing a fix to kick off a new CI run.",
  {
    run_url: z.string().describe("GitHub Actions run URL (same format as fetch_workflow_logs)"),
    failed_only: z.boolean().optional().default(true)
      .describe("When true, rerun only failed jobs (faster). Default: true."),
  },
  async ({ run_url, failed_only }) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return { content: [{ type: "text" as const, text: "GITHUB_TOKEN not set — cannot trigger rerun." }] };
    }

    const match = run_url.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
    if (!match) {
      return { content: [{ type: "text" as const, text: `Could not parse run URL: ${run_url}` }] };
    }

    const [, owner, repo, runId] = match;
    const endpoint = failed_only
      ? `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`
      : `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (resp.status === 201) {
      return { content: [{ type: "text" as const, text: `Rerun triggered for run #${runId} in ${owner}/${repo}.` }] };
    }
    if (resp.status === 403) {
      return { content: [{ type: "text" as const,
        text: `403 Forbidden — GITHUB_TOKEN needs Actions:Write scope to trigger reruns. ` +
              `Add it to your fine-grained token or use a classic PAT with 'repo' scope.` }] };
    }
    return { content: [{ type: "text" as const, text: `GitHub returned ${resp.status} for rerun request.` }] };
  },
);
```

### What is needed to build it

1. **Token scope update** — `GITHUB_TOKEN` documentation must be updated in README, AGENTS.md,
   and config.example.yaml. The new required scope for `rerun_workflow` is `Actions: Write`
   (fine-grained) or `repo` (classic). This is additive — `fetch_workflow_logs` still needs only
   `Actions: Read`. Users who only want log fetching do not need to change their token.

2. **Security note** — `Actions: Write` can trigger workflows and potentially run malicious code
   if a repo is compromised. Document this clearly. The tool should NOT be exposed in standalone
   mode unless `GITHUB_TOKEN` has Write scope.

3. **Add to `createMcpServer()`** in `src/server.ts:811`.

4. **Export for testing** and add unit tests:
   - Happy path: 201 response → correct message
   - 403: clear scope error message
   - `failed_only: false`: uses the base rerun endpoint
   - Invalid URL: graceful error

**Files to change:** `src/server.ts` (add tool), `README.md` (token scope table), `AGENTS.md`  
**New dependency:** None  
**Breaking change:** None — additive tool

---

## Feature 4 — `dependabot_alert` and `code_scanning_alert` events

### Problem

Dependabot vulnerability alerts and CodeQL code scanning findings are currently invisible to
claude-beacon. A critical CVE in a dependency or a high-severity SAST finding goes unnoticed
until a developer manually checks GitHub's Security tab. These are often more urgent than a CI
failure.

### What is delivered

Two new event handlers that push actionable notifications for security findings:

**Dependabot alert (new vulnerability):**
```
🔴 DEPENDABOT ALERT — HIGH severity in owner/repo
Package: lodash@4.17.20 (npm)
CVE: CVE-2021-23337 — Prototype Pollution
Affected path: package.json > lodash
GitHub advisory: https://github.com/advisories/GHSA-...

Act immediately — no confirmation needed.
Use the Agent tool NOW to spawn a subagent:
1. Run: npm audit fix (or bun add lodash@latest)
2. Run the test suite — verify nothing breaks
3. Commit and push
```

**Code scanning alert (new finding):**
```
🔴 CODE SCAN ALERT — HIGH severity in owner/repo
Rule: js/sql-injection | Tool: CodeQL
File: src/server.ts:245
Message: This query depends on user-provided value.

Act immediately — no confirmation needed.
Use the Agent tool NOW to spawn a subagent:
1. Review the finding at {alert_url}
2. Apply a fix or mark as dismissed with justification
3. Push the fix
```

### How it works

**GitHub webhook events:**
- `dependabot_alert` — fires on `created`, `dismissed`, `fixed`, `reintroduced`, `auto_dismissed`,
  `auto_reopened`, `reopened`. We handle `created` and `reintroduced` (severity ≥ medium).
- `security_advisory` — fires when a new advisory is published. Lower signal; skip initially.

**Payload structure (dependabot_alert):**
```typescript
// src/types.ts — new interface
export interface DependabotAlertPayload {
  action: "created" | "dismissed" | "fixed" | "reintroduced" | "auto_dismissed" | "auto_reopened" | "reopened";
  alert: {
    number: number;
    state: "open" | "dismissed" | "fixed";
    severity: "low" | "medium" | "high" | "critical";
    security_vulnerability: {
      package: { name: string; ecosystem: string };
      vulnerable_version_range: string;
      first_patched_version: { identifier: string } | null;
    };
    security_advisory: {
      ghsa_id: string;
      cve_id: string | null;
      summary: string;
      severity: "low" | "medium" | "high" | "critical";
    };
    html_url: string;
  };
  repository: { full_name: string };
  installation?: { id: number };
}
```

**Parse function:**
```typescript
// src/server.ts — new function
export function parseDependabotAlertEvent(
  payload: DependabotAlertPayload,
  config: Config,
): CINotification | null {
  // Only notify on new/reintroduced alerts of medium severity and above
  if (!["created", "reintroduced"].includes(payload.action)) return null;
  if (!["medium", "high", "critical"].includes(payload.alert.severity)) return null;

  const repo = sanitizeBody(payload.repository.full_name, 100);
  const pkg = sanitizeBody(payload.alert.security_vulnerability.package.name, 100);
  const ecosystem = sanitizeBody(payload.alert.security_vulnerability.package.ecosystem, 50);
  const severity = payload.alert.severity.toUpperCase();
  const cve = payload.alert.security_advisory.cve_id ?? payload.alert.security_advisory.ghsa_id;
  const summary = sanitizeBody(payload.alert.security_advisory.summary, 200);
  const alertUrl = payload.alert.html_url;
  const patchedVersion = payload.alert.security_vulnerability.first_patched_version?.identifier ?? "no patch available";

  const emoji = payload.alert.severity === "critical" ? "🔴" : "🟠";

  const lines = [
    `${emoji} DEPENDABOT ALERT — ${severity} severity in ${repo}`,
    `Package: ${pkg} (${ecosystem}) | CVE/Advisory: ${cve}`,
    `Summary: ${summary}`,
    `Patched in: ${patchedVersion}`,
    `URL: ${alertUrl}`,
    "",
    ...config.behavior.on_dependabot_alert.instruction
      .replace("{repo}", repo)
      .replace("{package}", pkg)
      .replace("{severity}", severity)
      .replace("{cve}", cve)
      .replace("{alert_url}", alertUrl)
      .split("\n"),
  ];

  return {
    summary: lines.join("\n"),
    meta: {
      source: "github-ci",
      event: "dependabot_alert",
      action: payload.action,
      repo,
      severity: payload.alert.severity,
    },
  };
}
```

### What is needed to build it

**1. GitHub webhook setup**

Users must add two more event types to their webhook:
- `Dependabot alerts` (under "Security" in webhook event selector)
- `Code scanning alerts` (under "Security" in webhook event selector)

Both require the repo to have Dependabot / Code scanning enabled. Document this in README and
config.example.yaml.

**2. New config fields** (`src/config.ts`):

```typescript
export interface BehaviorConfig {
  // ... existing fields ...
  on_dependabot_alert: DependabotAlertBehavior;
  on_code_scanning_alert: CodeScanningAlertBehavior;
}

export interface DependabotAlertBehavior {
  /** Minimum severity to notify on: "low" | "medium" | "high" | "critical". Default: "medium" */
  min_severity: "low" | "medium" | "high" | "critical";
  instruction: string;
}

export interface CodeScanningAlertBehavior {
  /** Minimum severity to notify on. Default: "high" */
  min_severity: "low" | "medium" | "high" | "critical" | "error" | "warning" | "note";
  instruction: string;
}
```

**3. New types** (`src/types.ts`):
- `DependabotAlertPayload` interface (structure above)
- `CodeScanningAlertPayload` interface (similar structure, different fields)

**4. Parse functions** (`src/server.ts`):
- `parseDependabotAlertEvent(payload, config)` → `CINotification | null`
- `parseCodeScanningAlertEvent(payload, config)` → `CINotification | null`

**5. Webhook handler routing** (`src/server.ts`, `startWebhookServer()`):
```typescript
case "dependabot_alert":
  return parseDependabotAlertEvent(payload as DependabotAlertPayload, config);
case "code_scanning_alert":
  return parseCodeScanningAlertEvent(payload as CodeScanningAlertPayload, config);
```

**6. `isActionable()` update** — add `"dependabot_alert"` and `"code_scanning_alert"` to the
actionable set.

**7. Tests** (`src/__tests__/server.test.ts`):
- Parse: high severity created → notification generated
- Parse: low severity created → null (filtered by min_severity)
- Parse: fixed action → null (not an alert)
- Sanitisation of package name and summary fields

**Files to change:** `src/types.ts`, `src/server.ts`, `src/config.ts`, `config.example.yaml`,
`README.md` (webhook event list), `AGENTS.md`

---

## Feature 5 — `use_agent: false` toggle for CI failures

### Problem

The CI failure instruction currently always says "Use the Agent tool NOW to spawn a subagent".
Solo developers working in a single Claude Code session often prefer Claude to fix CI issues
**inline** in the current session, rather than spawning a subagent. The mandatory subagent spawn:

- Adds latency (subagent initialisation takes several seconds)
- Consumes additional context tokens
- Can't use the parent session's open files or active context
- Feels unnecessarily heavy for small fixes (e.g. a linting violation or version bump)

### What is delivered

A new boolean config field `use_agent` in both `on_ci_failure_main` and `on_ci_failure_branch`.
When `false`, the notification instruction directs Claude to fix the issue in the current session
instead of spawning a subagent.

**Config:**
```yaml
behavior:
  on_ci_failure_branch:
    use_agent: false   # fix inline, no subagent spawn
    upstream_sync: true
    # instruction is auto-adjusted — no "Use Agent tool" line
```

**Notification with `use_agent: false` (branch failure):**
```
❌ CI FAILURE: CI on owner/repo
Branch: feat/my-feature | Commit: "..."

Fetch logs and diagnose:
  fetch_workflow_logs("https://github.com/...")

Act immediately — no confirmation needed.
Investigate the CI failure on branch feat/my-feature in owner/repo:
0. Health check: git fetch origin && git rebase origin/main
1. Call fetch_workflow_logs(...) to read the failure
2. Identify the root cause and fix it
3. Push the fix to the branch.
```

vs current (`use_agent: true`, the default):
```
...
Use the Agent tool NOW to spawn a subagent with these instructions:
Investigate the CI failure on branch feat/my-feature in owner/repo:
...
```

### How it works

**Config change** (`src/config.ts`):

```typescript
export interface CIFailureBehavior {
  instruction: string;
  upstream_sync: boolean;
  /**
   * When true (default), Claude is instructed to spawn a subagent via the Agent tool.
   * When false, Claude fixes the CI failure inline in the current session — no subagent spawn.
   * Recommended for solo developers with a single session; keep true for teams.
   */
  use_agent: boolean;
}
```

Default values:
```typescript
on_ci_failure_main: {
  use_agent: true,   // default: spawn subagent (existing behaviour)
  upstream_sync: true,
  instruction: "...",
},
on_ci_failure_branch: {
  use_agent: true,
  upstream_sync: true,
  instruction: "...",
},
```

**Notification builder** (`src/server.ts`, `parseWorkflowRunEvent` or the interpolation block):

The `{use_agent_preamble}` placeholder (analogous to `{health_check_step}`) is computed at
notification time:

```typescript
const useAgentPreamble = ciFailureBehavior.use_agent
  ? "Use the Agent tool NOW to spawn a subagent with these instructions:"
  : "Act in the current session (no subagent needed):";
```

The DEFAULT_CONFIG instructions are updated to use this placeholder:
```typescript
on_ci_failure_branch: {
  use_agent: true,
  upstream_sync: true,
  instruction: [
    "Act immediately — no confirmation needed.",
    "{use_agent_preamble}",
    "Investigate the CI failure on branch {branch} in {repo}:",
    "{health_check_step}",
    '1. Call fetch_workflow_logs("{run_url}") to read the failure',
    "2. Identify the root cause and fix it",
    "3. Push the fix to the branch.",
  ].join("\n"),
},
```

### What is needed to build it

1. **`CIFailureBehavior` interface** (`src/config.ts:54`) — add `use_agent: boolean`

2. **DEFAULT_CONFIG** (`src/config.ts:178`) — add `use_agent: true` to both behaviors

3. **Interpolation block** (`src/server.ts`, the `vars` object near line 335) — compute
   `use_agent_preamble` and add to `vars`:
   ```typescript
   const useAgentPreamble = ciFailureBehavior.use_agent
     ? "Use the Agent tool NOW to spawn a subagent with these instructions:"
     : "Act in the current session:";
   const vars = {
     // ... existing vars ...
     health_check_step: healthCheckStep,
     use_agent_preamble: useAgentPreamble,
   };
   ```

4. **DEFAULT_CONFIG instructions** — replace hardcoded "Use the Agent tool NOW" with
   `{use_agent_preamble}` placeholder in both `on_ci_failure_main` and `on_ci_failure_branch`.

5. **config.example.yaml** — add `use_agent: true` with comment explaining the `false` option.

6. **Tests** (`src/__tests__/config.test.ts`):
   - `use_agent: false` → instruction contains "Act in the current session", not "Agent tool"
   - `use_agent: true` (default) → instruction contains "Use the Agent tool NOW"
   - Existing tests must still pass (behaviour unchanged when `use_agent` not set)

7. **README / AGENTS.md** — document `use_agent` in the behavior config table

**Files to change:** `src/config.ts`, `src/server.ts`, `config.example.yaml`, `README.md`,
`AGENTS.md`  
**New dependency:** None  
**Breaking change:** None — `use_agent: true` is the default, preserving existing behaviour

---

## Implementation order recommendation

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 1 | `use_agent` toggle | Small (2–3 h) | Unblocks solo developers immediately |
| 2 | `rerun_workflow` tool | Small (2–3 h) | Completes the CI automation loop |
| 3 | Startup hooks / auto `set_filter` | Medium (1 day) | Eliminates #1 new-user problem |
| 4 | Dependabot + code scanning | Medium (1 day) | Closes security blind spot |
| 5 | MCP status line | Medium (0.5–1 day) | Requires SDK verification first |

Features 1 and 2 are fully specified and can be started immediately without any open questions.
Feature 5 requires checking whether `claude/statusLine` notifications are supported in the Claude
Code MCP SDK before implementation begins.
