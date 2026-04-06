import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

// ── Config Types ──────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** HTTP port for the webhook server. Env override: WEBHOOK_PORT */
  port: number;
  /** Milliseconds to wait before firing a batched review notification. Env override: REVIEW_DEBOUNCE_MS */
  debounce_ms: number;
  /** Milliseconds to suppress further notifications for the same PR after one fires. */
  cooldown_ms: number;
  /** Maximum review events buffered per debounce window (memory / prompt-size guard). */
  max_events_per_window: number;
  /** Branch names treated as the default/main branch for CI failure escalation. */
  main_branches: string[];
  /**
   * How long a work-context claim holds before expiring (milliseconds).
   * Claims are auto-renewed when the owner calls claim_notification again.
   * Default: 10 minutes.
   */
  claim_ttl_ms: number;
}

export interface WebhooksConfig {
  /**
   * REQUIRED — GitHub usernames and/or email addresses whose PRs trigger actions.
   * MCP refuses to start if this list is empty.
   *
   * Two kinds of entries:
   * - Plain username (no "@"): matched against pr.user.login (the PR author's GitHub handle).
   * - Email address (contains "@"): matched against Co-Authored-By commit headers.
   *   Use this when a bot like Devin creates the PR on your behalf — your email appears
   *   in the commit's Co-Authored-By trailer even though the PR author is the bot.
   *
   * Example: ["Matovidlo", "martin@company.com"]
   */
  allowed_authors: string[];
  /**
   * GitHub event types to process. Empty array means all supported events are processed.
   *
   * Supported values: push, workflow_run, workflow_job, check_suite, check_run,
   * pull_request, pull_request_review, pull_request_review_comment,
   * pull_request_review_thread, issue_comment
   */
  allowed_events: string[];
  /**
   * Repository full names (owner/repo) to process. Empty array means all repositories.
   * Example: ["myorg/frontend", "myorg/backend"]
   */
  allowed_repos: string[];
}

export interface CIFailureBehavior {
  /**
   * Instruction template appended to CI failure notifications.
   *
   * Available placeholders: {repo}, {branch}, {run_url}, {workflow}, {status}, {commit}
   *
   * The special placeholder {health_check_step} is replaced automatically based on
   * the `upstream_sync` field below — include it in the template wherever you want
   * the sync step to appear, or omit it entirely to suppress the step.
   *
   * The special placeholder {use_agent_preamble} is replaced with either a directive
   * to spawn a subagent (when use_agent=true) or to act in the current session
   * (when use_agent=false). Include it wherever you want that line to appear.
   */
  instruction: string;
  /**
   * When true (default), a "step 0" is injected via the {health_check_step} placeholder:
   * fetch + rebase origin/main before diagnosing the failure. This catches cases where
   * the branch is simply stale and the failure is already fixed upstream.
   *
   * Set to false to skip the sync step (e.g. on repos where main is frequently broken,
   * or when you handle rebasing separately).
   */
  upstream_sync: boolean;
  /**
   * When true (default), Claude spawns a subagent via the Agent tool to investigate
   * and fix the CI failure. This keeps the parent session free for other work.
   *
   * Set to false to have Claude act inline in the current session — useful for solo
   * developers who prefer a single context or who find the subagent latency disruptive.
   */
  use_agent: boolean;
}

/**
 * Controls how git worktrees are created for subagent tasks.
 *
 * - "temp": classic shell worktree — `git worktree add /tmp/... && git worktree remove`
 * - "native": Claude Code's Agent tool with `isolation: "worktree"` — Claude manages the
 *   worktree lifecycle automatically; no manual add/remove needed.
 */
export type WorktreeMode = "temp" | "native";

export interface WorktreeConfig {
  /**
   * Worktree strategy used when spawning subagents for rebase / conflict resolution.
   * Defaults to "temp". Use "native" if you work in Claude Code worktrees natively
   * (i.e. you run `claude` from inside an Agent-managed worktree).
   */
  mode: WorktreeMode;
}

export interface PRReviewBehavior {
  /**
   * Whether to require the agent to enter plan mode before applying any fixes.
   * When true the instruction should include an explicit EnterPlanMode directive.
   */
  require_plan: boolean;
  /** Skill name invoked during the execution phase. */
  skill: string;
  /**
   * When true, the PR review work runs as a subagent inside an isolated Claude Code
   * worktree (Agent tool with isolation="worktree") instead of the current session.
   * Useful when you normally work inside native worktrees.
   */
  use_worktree: boolean;
  /**
   * Instruction text appended to PR review notifications.
   *
   * Available placeholders:
   *   {skill}             — replaced with the skill field above
   *   {worktree_preamble} — empty when use_worktree=false; when true, a sentence
   *                         telling the subagent it already runs in an isolated worktree
   */
  instruction: string;
}

export interface PRStateBehavior {
  /**
   * Instruction template for PRs in a conflict or behind state.
   *
   * Available placeholders: {repo}, {pr_number}, {pr_title}, {pr_url}, {head_branch},
   *   {base_branch}, {worktree_steps} — mode-appropriate rebase/cleanup commands
   */
  instruction: string;
}

export type DependabotMinSeverity = "low" | "medium" | "high" | "critical";
export type CodeScanningMinSeverity = "note" | "warning" | "error";

export interface SecurityAlertBehavior<S extends string> {
  /**
   * Whether this alert handler is active. Defaults to false.
   *
   * Security alerts broadcast to ALL sessions registered for the repo. In shared/team
   * environments, multiple Claude Code instances would all receive the alert. Set to true
   * only on the single instance responsible for security triage.
   */
  enabled: boolean;
  /**
   * Minimum severity required to trigger a notification.
   * Alerts below this threshold are silently skipped.
   */
  min_severity: S;
  /**
   * Instruction template appended to security alert notifications.
   *
   * Dependabot placeholders: {repo}, {cve}, {package}, {severity}, {alert_url}, {patched_version}
   * Code scanning placeholders: {repo}, {rule}, {severity}, {alert_url}, {branch}, {tool}
   */
  instruction: string;
}

export interface BehaviorConfig {
  /** Worktree strategy for all subagent operations. */
  worktrees: WorktreeConfig;
  /** Behaviour when a CI run fails on a main/master branch. */
  on_ci_failure_main: CIFailureBehavior;
  /** Behaviour when a CI run fails on a feature branch. */
  on_ci_failure_branch: CIFailureBehavior;
  /** Behaviour when a PR review or comment arrives. */
  on_pr_review: PRReviewBehavior;
  /** Behaviour when a PR has merge conflicts (mergeable_state=dirty). */
  on_merge_conflict: PRStateBehavior;
  /** Behaviour when a PR is behind its base branch (mergeable_state=behind). */
  on_branch_behind: PRStateBehavior;
  /** Behaviour when a Dependabot security alert is created or reintroduced. */
  on_dependabot_alert: SecurityAlertBehavior<DependabotMinSeverity>;
  /** Behaviour when a code scanning (SAST) alert is created. */
  on_code_scanning_alert: SecurityAlertBehavior<CodeScanningMinSeverity>;
}

export interface Config {
  server: ServerConfig;
  webhooks: WebhooksConfig;
  behavior: BehaviorConfig;
  /**
   * Project-specific code style guidelines prepended to every PR review notification.
   * Leave empty to omit. Use this to teach the agent your naming conventions,
   * formatting rules, preferred patterns, etc.
   */
  code_style: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────
// Mirrors the hardcoded behaviour that existed before the config system.
// Environment variables still take precedence over the YAML for server settings.

export const DEFAULT_CONFIG: Config = {
  server: {
    port: Number.parseInt(process.env.WEBHOOK_PORT ?? "9443", 10) || 9443,
    debounce_ms: Number.parseInt(process.env.REVIEW_DEBOUNCE_MS ?? "30000", 10) || 30_000,
    cooldown_ms: 5 * 60 * 1000,
    max_events_per_window: 50,
    main_branches: ["main", "master"],
    claim_ttl_ms: 10 * 60 * 1000,
  },
  webhooks: {
    allowed_authors: [],
    allowed_events: [],
    allowed_repos: [],
  },
  behavior: {
    worktrees: {
      mode: "temp",
    },
    on_ci_failure_main: {
      upstream_sync: true,
      use_agent: true,
      instruction: [
        "Main branch is broken. Act immediately — no confirmation needed.",
        "{use_agent_preamble}",
        "Diagnose and fix the broken CI on main in {repo}:",
        "{health_check_step}",
        '1. Call fetch_workflow_logs("{run_url}") to read the failure',
        "2. Identify the failing step and root cause",
        "3. Apply a targeted fix in the codebase",
        "4. Commit and push to restore main",
        "5. Confirm CI is green.",
      ].join("\n"),
    },
    on_ci_failure_branch: {
      upstream_sync: true,
      use_agent: true,
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
    on_pr_review: {
      require_plan: true,
      skill: "pr-comment-response",
      use_worktree: true,
      instruction: [
        "{worktree_preamble}Plan before acting:",
        "1. Read every linked thread and summarise what each asks for",
        "2. List the exact file + change for each thread",
        "3. Only after planning, use the {skill} skill to execute",
        "",
        "Do NOT apply any fix before the plan step is done.",
        "",
        "Execution phase:",
        "1. For each comment thread above, open the link and read full context",
        "2. Code comments: apply the fix, commit",
        "3. Questions / style: reply inline with a concise explanation",
        "4. Use gh-pr-reply.sh --batch to post all replies in one shot",
      ].join("\n"),
    },
    on_merge_conflict: {
      instruction: [
        "PR #{pr_number} has merge conflicts with {base_branch}. Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Resolve merge conflicts for PR #{pr_number} in {repo}:",
        "{worktree_steps}",
      ].join("\n"),
    },
    on_branch_behind: {
      instruction: [
        "PR #{pr_number} is behind {base_branch} (no conflicts). Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Rebase PR #{pr_number} in {repo}:",
        "{worktree_steps}",
      ].join("\n"),
    },
    on_dependabot_alert: {
      enabled: false,
      min_severity: "medium",
      instruction: [
        "🚨 Dependabot alert on {repo}: {severity} vulnerability in {package} ({cve})",
        "Patched in: {patched_version}",
        "Details: {alert_url}",
        "",
        "Review the alert and update the dependency to the patched version.",
      ].join("\n"),
    },
    on_code_scanning_alert: {
      enabled: false,
      min_severity: "warning",
      instruction: [
        "🔍 Code scanning alert on {repo} ({branch}): {rule} [{severity}] via {tool}",
        "Details: {alert_url}",
        "",
        "Review the finding and apply a fix.",
      ].join("\n"),
    },
  },
  code_style: "",
};

// ── Worktree Step Builders ────────────────────────────────────────────────────

/**
 * Build the mode-appropriate steps for a rebase subagent.
 * The returned string replaces the {worktree_steps} placeholder in on_merge_conflict
 * and on_branch_behind instruction templates.
 */
export function buildWorktreeRebaseSteps(
  mode: WorktreeMode,
  vars: { pr_number: string; head_branch: string; base_branch: string },
  withConflicts: boolean,
): string {
  const { pr_number, head_branch, base_branch } = vars;

  if (mode === "native") {
    // Claude Code's Agent tool manages the worktree automatically when isolation="worktree"
    // is passed. The subagent starts directly inside the isolated worktree branch.
    const rebaseStep = withConflicts
      ? `2. git fetch origin && git rebase origin/${base_branch} — fix conflicts, then: git add -A && git rebase --continue`
      : `2. git fetch origin && git rebase origin/${base_branch}`;
    return [
      `Use the Agent tool with isolation="worktree" and these instructions for branch ${head_branch}:`,
      `1. You are already in an isolated worktree on branch ${head_branch}`,
      rebaseStep,
      `3. git push --force-with-lease origin ${head_branch}`,
    ].join("\n");
  }

  // Default: temp worktree via shell commands
  const rebaseStep = withConflicts
    ? `3. git rebase origin/${base_branch} — fix conflicts, then: git add -A && git rebase --continue`
    : `3. git rebase origin/${base_branch}`;
  return [
    `1. git worktree add /tmp/pr-${pr_number}-rebase ${head_branch}`,
    `2. cd /tmp/pr-${pr_number}-rebase && git fetch origin`,
    rebaseStep,
    `4. git push --force-with-lease origin ${head_branch}`,
    `5. git worktree remove /tmp/pr-${pr_number}-rebase`,
  ].join("\n");
}

/**
 * Build the {worktree_preamble} for on_pr_review instructions.
 * Empty string when use_worktree=false; a directive sentence when true.
 */
export function buildWorktreePreamble(useWorktree: boolean): string {
  if (!useWorktree) return "";
  return (
    'You are running inside an isolated Claude Code worktree (isolation="worktree"). ' +
    "All file edits and commits apply directly to this worktree — no separate setup needed.\n\n"
  );
}

// ── Template Interpolation ────────────────────────────────────────────────────

/** Replace {key} placeholders in a template string. Unknown placeholders are left unchanged. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ── Deep Merge ────────────────────────────────────────────────────────────────

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val === undefined || val === null) continue;
    const baseVal = base[key];
    if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as object, val as object) as T[keyof T];
    } else {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

// ── Config Loader ─────────────────────────────────────────────────────────────

/**
 * Load a YAML config file and deep-merge it with DEFAULT_CONFIG.
 * Only the fields present in the file are overridden; everything else keeps its default.
 *
 * Environment variables still win over the YAML file for server.port and server.debounce_ms
 * because DEFAULT_CONFIG already reads them from process.env.
 *
 * @throws if the file is missing or contains invalid YAML / non-object content.
 */
export function loadConfig(filePath: string): Config {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must be a YAML object: ${filePath}`);
  }
  return deepMerge(DEFAULT_CONFIG, parsed as Partial<Config>);
}
