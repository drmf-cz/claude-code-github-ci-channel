import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  buildWorktreePreamble,
  buildWorktreeRebaseSteps,
  DEFAULT_CONFIG,
  interpolate,
} from "./config.js";
import type {
  CINotification,
  GitHubPushPayload,
  GitHubWebhookPayload,
  IssueComment,
  MergeableState,
  PRReview,
  PRReviewComment,
} from "./types.js";

// ── Routing types ─────────────────────────────────────────────────────────────

/** Routing key extracted from each webhook event for session-level filtering. */
export interface RoutingKey {
  repo: string;
  /** Branch the event originated from. null = send to all sessions for this repo. */
  branch: string | null;
}

/**
 * Callback invoked for every actionable webhook event.
 * Standalone mode: pushes directly to the embedded MCP session.
 * Mux mode: routes to the matching HTTP-connected session(s).
 */
export type NotifyFn = (notification: CINotification, routing: RoutingKey) => Promise<void>;

// ── Configuration ─────────────────────────────────────────────────────────────
const MAX_LOG_CHARS = 8000;

/** Event types that carry PR review / comment payloads. Used in routing and dispatch. */
const REVIEW_EVENTS = new Set([
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
]);

/** Event types that carry CI run / job / check payloads. Used in routing and dispatch. */
const CI_EVENTS = new Set(["workflow_run", "workflow_job", "check_suite"]);

// ── Security ──────────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB — increased to handle large PR review payloads
/** Returns true if the raw body exceeds the allowed limit. */
export function isOversized(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES;
}

/** Bounded set of recently seen X-GitHub-Delivery IDs (replay protection). */
const SEEN_DELIVERIES = new Set<string>();
const MAX_SEEN_DELIVERIES = 1_000;

/**
 * Returns true if this delivery ID has been processed before.
 * Automatically prunes the oldest entry when the set is full.
 */
export function isDuplicateDelivery(id: string): boolean {
  if (!id) return false;
  if (SEEN_DELIVERIES.has(id)) return true;
  if (SEEN_DELIVERIES.size >= MAX_SEEN_DELIVERIES) {
    // Delete the oldest (first inserted) entry
    SEEN_DELIVERIES.delete(SEEN_DELIVERIES.values().next().value ?? "");
  }
  SEEN_DELIVERIES.add(id);
  return false;
}

/**
 * Sanitize a user-supplied string before embedding it in a notification Claude reads.
 * - Strips null bytes and Unicode bidirectional-override characters (prompt injection vector)
 * - Collapses runs of whitespace/newlines (defeats multi-line injections)
 * - Truncates to maxLen
 */
export function sanitizeBody(body: string, maxLen = 500): string {
  return (
    body
      .replaceAll("\x00", "") // strip null bytes
      // strip Unicode bidi-override and zero-width characters used to hide injected text
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/[\r\n\t]+/g, " ") // collapse runs of whitespace
      .trim()
      .slice(0, maxLen)
  );
}

/**
 * Categorizes a GitHub webhook event into a broad group.
 * Returns "ci", "review", "push", or "other".
 */
export function categorizeEvent(
  event: string,
  _action: string,
): "ci" | "review" | "push" | "other" {
  if (CI_EVENTS.has(event)) {
    return "ci";
  }
  if (event === "pull_request" || REVIEW_EVENTS.has(event)) {
    return "review";
  }
  if (event === "push") {
    return "push";
  }
  return "other";
}

/** Fetch with a hard timeout. Aborts and rejects if the request exceeds `ms` milliseconds. */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── PR Review Debounce ────────────────────────────────────────────────────────

export interface ReviewEventRecord {
  type: "review" | "review_comment" | "issue_comment" | "unresolved_thread";
  reviewer: string;
  /** Review state from PRReview — undefined for comment/thread events. */
  state?: PRReview["state"];
  body: string;
  url: string;
  /** File path for line-level comments */
  path?: string;
}

interface PendingPRReview {
  timer: ReturnType<typeof setTimeout>;
  events: ReviewEventRecord[];
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repo: string;
}

// Exported for testing
export const pendingReviews = new Map<string, PendingPRReview>();
export const reviewCooldowns = new Map<string, number>(); // key → expiry timestamp (ms)

export function isInReviewCooldown(key: string): boolean {
  const expiry = reviewCooldowns.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    reviewCooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * Accumulate review events within a debounce window. Returns false if the key
 * is in cooldown (event discarded), true otherwise.
 *
 * When the timer fires, `onFire` is called with all accumulated events, then
 * a cooldown is set for the key so subsequent bursts are dropped.
 *
 * `opts` overrides the debounce/cooldown/cap values from DEFAULT_CONFIG when provided.
 */
export function scheduleReviewNotification(
  key: string,
  prMeta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
  event: ReviewEventRecord,
  onFire: (
    events: ReviewEventRecord[],
    meta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
  ) => void,
  opts: { debounceMs?: number; cooldownMs?: number; maxEvents?: number } = {},
): boolean {
  const debounceMs = opts.debounceMs ?? DEFAULT_CONFIG.server.debounce_ms;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_CONFIG.server.cooldown_ms;
  const maxEvents = opts.maxEvents ?? DEFAULT_CONFIG.server.max_events_per_window;

  if (isInReviewCooldown(key)) return false;

  const existing = pendingReviews.get(key);
  if (existing) {
    if (existing.events.length >= maxEvents) return false; // window full
    clearTimeout(existing.timer);
    existing.events.push(event);
    existing.timer = setTimeout(() => {
      const entry = pendingReviews.get(key);
      pendingReviews.delete(key);
      reviewCooldowns.set(key, Date.now() + cooldownMs);
      if (entry) onFire(entry.events, prMeta);
    }, debounceMs);
  } else {
    const entry: PendingPRReview = {
      ...prMeta,
      events: [event],
      timer: setTimeout(() => {
        pendingReviews.delete(key);
        reviewCooldowns.set(key, Date.now() + cooldownMs);
        onFire(entry.events, prMeta);
      }, debounceMs),
    };
    pendingReviews.set(key, entry);
  }
  return true;
}

export function buildReviewNotification(
  events: ReviewEventRecord[],
  meta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
  config: Config = DEFAULT_CONFIG,
): CINotification {
  // Group by reviewer preserving insertion order
  const byReviewer = new Map<string, ReviewEventRecord[]>();
  for (const ev of events) {
    const list = byReviewer.get(ev.reviewer) ?? [];
    list.push(ev);
    byReviewer.set(ev.reviewer, list);
  }

  const lines: string[] = [
    `📝 PR REVIEW — PR #${meta.prNumber}: "${meta.prTitle}"`,
    `Repo: ${meta.repo} | URL: ${meta.prUrl}`,
    "",
    `${events.length} review event(s) received — consolidated notification:`,
    "",
  ];

  for (const [reviewer, revEvents] of byReviewer) {
    const reviewRecord = revEvents.find((e) => e.type === "review");
    const stateLabel = reviewRecord?.state ? ` [${reviewRecord.state}]` : "";
    lines.push(`@${reviewer}${stateLabel}:`);
    for (const ev of revEvents) {
      const snippet = ev.body.slice(0, 120);
      const location = ev.path ? ` (${ev.path})` : "";
      const prefix = ev.type === "unresolved_thread" ? "🔄 re-opened" : "•";
      lines.push(`  ${prefix} "${snippet}"${location}`);
      lines.push(`    → ${ev.url}`);
    }
  }

  if (config.code_style) {
    lines.push("", "── Code style guidelines ──", config.code_style);
  }

  const behavior = config.behavior.on_pr_review;
  const instruction = interpolate(behavior.instruction, {
    skill: behavior.skill,
    worktree_preamble: buildWorktreePreamble(behavior.use_worktree),
  });
  lines.push("", ...instruction.split("\n"));

  return {
    summary: lines.join("\n"),
    meta: {
      source: "github-ci",
      event: "pr_review",
      repo: meta.repo,
      pr_number: String(meta.prNumber),
      pr_title: meta.prTitle,
      pr_url: meta.prUrl,
      event_count: String(events.length),
    },
  };
}

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

// ── HMAC-SHA256 Verification ──────────────────────────────────────────────────
export function verifySignature(payload: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret) {
    if (process.env.WEBHOOK_DEV_MODE === "true") {
      log("WARNING: No GITHUB_WEBHOOK_SECRET set — skipping verification (WEBHOOK_DEV_MODE=true)");
      return true;
    }
    log(
      "ERROR: No GITHUB_WEBHOOK_SECRET configured — rejecting request (set WEBHOOK_DEV_MODE=true to bypass in dev)",
    );
    return false;
  }
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_EMOJI: Record<string, string> = {
  success: "✅",
  failure: "❌",
  cancelled: "⚠️",
  timed_out: "⏱️",
  skipped: "⏭️",
};

function statusEmoji(conclusion: string | null): string {
  return STATUS_EMOJI[conclusion ?? ""] ?? "⚠️";
}

function formatDuration(startedAt: string | null, updatedAt: string | null): string {
  if (!startedAt || !updatedAt) return "unknown";
  const ms = new Date(updatedAt).getTime() - new Date(startedAt).getTime();
  return `${Math.round(ms / 1000)}s`;
}

// ── Event Parsing ─────────────────────────────────────────────────────────────
function parseWorkflowRunEvent(
  event: string,
  payload: GitHubWebhookPayload,
  repo: string,
  config: Config,
): CINotification | null {
  const run = payload.workflow_run;
  if (!run) {
    log(`[skip] workflow_run: no workflow_run object in payload`);
    return null;
  }

  // Only notify on failures — successes, cancellations, etc. are silent
  if (run.conclusion !== "failure") {
    log(
      `[skip] workflow_run "${run.name ?? "?"}" on ${repo}@${run.head_branch ?? "?"}: conclusion=${run.conclusion} (only "failure" notifies)`,
    );
    return null;
  }

  const status = run.conclusion ?? run.status;
  const emoji = statusEmoji(run.conclusion);
  const commitMsg = sanitizeBody(run.head_commit?.message?.split("\n")[0] ?? "", 200);
  const headBranch = sanitizeBody(run.head_branch ?? "", 100);
  const workflowName = sanitizeBody(run.name ?? "", 100);
  const duration = formatDuration(run.run_started_at, run.updated_at);
  const mainBranches = new Set(config.server.main_branches);
  const isMainBranch = mainBranches.has(run.head_branch);

  const lines = [
    `${emoji} CI ${status.toUpperCase()}: ${workflowName} on ${repo}`,
    `Branch: ${headBranch} | Commit: "${commitMsg}"`,
    `Duration: ${duration} | Run #${run.run_number}`,
    `URL: ${run.html_url}`,
  ];

  if (status === "failure") {
    lines.push("", "Fetch logs and diagnose:", `  fetch_workflow_logs("${run.html_url}")`);

    const vars = {
      repo,
      branch: headBranch,
      run_url: run.html_url,
      workflow: workflowName,
      status,
      commit: commitMsg,
    };
    const template = isMainBranch
      ? config.behavior.on_ci_failure_main.instruction
      : config.behavior.on_ci_failure_branch.instruction;
    lines.push("", ...interpolate(template, vars).split("\n"));
  }

  return {
    summary: lines.join("\n"),
    meta: {
      source: "github-ci",
      event,
      action: payload.action ?? "",
      repo,
      branch: run.head_branch,
      status,
      workflow: run.name,
      run_url: run.html_url,
      run_id: String(run.id ?? ""),
      sender: payload.sender?.login ?? "",
    },
  };
}

export function parseWorkflowEvent(
  event: string,
  payload: GitHubWebhookPayload,
  config: Config = DEFAULT_CONFIG,
): CINotification | null {
  const repo = payload.repository?.full_name ?? "unknown";

  if (event === "workflow_run") {
    return parseWorkflowRunEvent(event, payload, repo, config);
  }

  if (event === "workflow_job") {
    const job = payload.workflow_job;
    if (!job || payload.action !== "completed") {
      log(`[skip] workflow_job: action=${payload.action ?? "none"} (only "completed" acts)`);
      return null;
    }
    if (job.conclusion !== "failure") {
      log(
        `[skip] workflow_job "${job.name ?? "?"}" on ${repo}: conclusion=${job.conclusion} (only "failure" notifies)`,
      );
      return null;
    }

    const status = job.conclusion ?? "unknown";
    const emoji = statusEmoji(job.conclusion);
    const jobName = sanitizeBody(job.name ?? "", 200);
    const runnerName = sanitizeBody(job.runner_name ?? "unknown", 100);
    const labels = (job.labels ?? []).map((l) => sanitizeBody(l, 50)).join(", ");
    const failedSteps = (job.steps ?? [])
      .filter((s) => s.conclusion === "failure")
      .map((s) => `  - Step "${sanitizeBody(s.name ?? "", 100)}" failed`)
      .join("\n");

    const lines = [
      `${emoji} Job ${status.toUpperCase()}: "${jobName}" in ${repo}`,
      `Runner: ${runnerName} | Labels: ${labels}`,
      `URL: ${job.html_url}`,
    ];
    if (failedSteps) lines.push(`\nFailed steps:\n${failedSteps}`);

    return {
      summary: lines.join("\n"),
      meta: {
        source: "github-ci",
        event,
        action: payload.action ?? "",
        repo,
        status,
        job_name: job.name,
        job_url: job.html_url,
      },
    };
  }

  if (event === "check_suite" || event === "check_run") {
    const check = event === "check_suite" ? payload.check_suite : payload.check_run;
    if (!check || payload.action !== "completed") {
      log(`[skip] ${event}: action=${payload.action ?? "none"} (only "completed" acts)`);
      return null;
    }
    if (check.conclusion !== "failure") {
      const name = "name" in check ? (check.name ?? "?") : (check.app?.name ?? "?");
      log(
        `[skip] ${event} "${name}" on ${repo}: conclusion=${check.conclusion} (only "failure" notifies)`,
      );
      return null;
    }

    const status = check.conclusion ?? "unknown";
    const emoji = statusEmoji(check.conclusion);
    const name = "name" in check ? check.name : (check.app?.name ?? "Check");

    return {
      summary: `${emoji} ${event} ${status}: ${name} on ${repo}`,
      meta: { source: "github-ci", event, status, repo },
    };
  }

  // Fallback for unknown events — do NOT include raw payload (prompt injection risk)
  return {
    summary: `GitHub event "${event}" (action: ${payload.action ?? "none"}) on ${repo}`,
    meta: { source: "github-ci", event, action: payload.action ?? "", repo },
  };
}

export function parsePullRequestEvent(
  payload: GitHubWebhookPayload,
  config: Config = DEFAULT_CONFIG,
): CINotification | null {
  const pr = payload.pull_request;
  if (!pr) return null;

  const repo = payload.repository?.full_name ?? "unknown";
  const state: MergeableState = pr.mergeable_state;
  // Sanitize user-controlled fields before embedding in notifications Claude acts on
  const prTitle = sanitizeBody(pr.title ?? "", 200);
  const headBranch = sanitizeBody(pr.head.ref ?? "", 100);
  const baseBranch = sanitizeBody(pr.base.ref ?? "", 100);

  const prVars = {
    repo,
    pr_number: String(pr.number),
    pr_title: prTitle,
    pr_url: pr.html_url,
    head_branch: headBranch,
    base_branch: baseBranch,
  };
  const prMeta = {
    source: "github-ci",
    event: "pull_request",
    action: payload.action ?? "",
    repo,
    pr_number: String(pr.number),
    pr_title: prTitle,
    head_branch: headBranch,
    base_branch: baseBranch,
    pr_url: pr.html_url,
    mergeable_state: state,
    sender: payload.sender?.login ?? "",
  };

  const worktreeMode = config.behavior.worktrees.mode;

  if (state === "dirty") {
    const worktreeSteps = buildWorktreeRebaseSteps(worktreeMode, prVars, true);
    const instruction = interpolate(config.behavior.on_merge_conflict.instruction, {
      ...prVars,
      worktree_steps: worktreeSteps,
    });
    return {
      summary: [
        `⚠️ MERGE CONFLICT — PR #${pr.number}: "${prTitle}"`,
        `Repo: ${repo} | Branch: ${headBranch} → ${baseBranch}`,
        `URL: ${pr.html_url}`,
        "",
        instruction,
      ].join("\n"),
      meta: prMeta,
    };
  }

  if (state === "behind") {
    const worktreeSteps = buildWorktreeRebaseSteps(worktreeMode, prVars, false);
    const instruction = interpolate(config.behavior.on_branch_behind.instruction, {
      ...prVars,
      worktree_steps: worktreeSteps,
    });
    return {
      summary: [
        `⬇️ BRANCH BEHIND BASE — PR #${pr.number}: "${prTitle}"`,
        `Repo: ${repo} | Branch: ${headBranch} → ${baseBranch}`,
        `URL: ${pr.html_url}`,
        "",
        instruction,
      ].join("\n"),
      meta: prMeta,
    };
  }

  log(
    `[skip] pull_request PR #${pr.number} on ${repo}: mergeable_state=${state} (only "dirty" or "behind" notifies)`,
  );
  return null;
}

// ── Push → PR Behind Detection ────────────────────────────────────────────────

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchPRMergeableState(
  repo: string,
  prNumber: number,
  token: string,
): Promise<MergeableState> {
  const resp = await fetchWithTimeout(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: githubApiHeaders(token),
  });
  if (!resp.ok) return "unknown";
  const pr = (await resp.json()) as { mergeable_state: MergeableState };
  return pr.mergeable_state;
}

/**
 * Called when a push lands on a default branch.
 * Lists open PRs targeting that branch and emits notifications for any that
 * are now `behind` or `dirty`. Responds to GitHub immediately; this runs async.
 *
 * GitHub computes mergeability asynchronously after a push — we retry once
 * after a short delay if the state is still `unknown`.
 */
export async function checkPRsAfterPush(
  repo: string,
  baseBranch: string,
  token: string,
  notify: NotifyFn,
  config: Config = DEFAULT_CONFIG,
): Promise<void> {
  // Give GitHub a moment to start computing mergeability
  await new Promise<void>((r) => setTimeout(r, 4_000));

  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/pulls?state=open&base=${baseBranch}&per_page=20`,
    { headers: githubApiHeaders(token) },
    15_000,
  );

  if (!resp.ok) {
    log(`PR list fetch failed: ${resp.status}`);
    return;
  }

  // Note: the list endpoint never populates mergeable_state — always null.
  // We must fetch each PR individually to get the real value.
  const prs = (await resp.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    user: { login: string };
  }>;

  for (const pr of prs) {
    if (!isAuthorAllowed(pr.user.login, config.webhooks.allowed_authors)) {
      const coAuthorMatch = await isCoAuthorAllowed(
        repo,
        pr.number,
        token,
        config.webhooks.allowed_authors,
      );
      if (!coAuthorMatch) {
        log(`PR #${pr.number} author "${pr.user.login}" not in allowed_authors — skipping`);
        continue;
      }
    }

    // Always fetch individual PR — list endpoint omits mergeable_state
    let state = await fetchPRMergeableState(repo, pr.number, token);

    // Retry once if GitHub is still computing (common immediately after a push)
    if (state === "unknown") {
      await new Promise<void>((r) => setTimeout(r, 5_000));
      state = await fetchPRMergeableState(repo, pr.number, token);
    }

    if (state !== "dirty" && state !== "behind") continue;

    const notification = parsePullRequestEvent(
      {
        action: "synchronize",
        pull_request: {
          number: pr.number,
          title: pr.title,
          state: "open",
          html_url: pr.html_url,
          head: { ref: pr.head.ref, sha: "" },
          base: { ref: pr.base.ref, sha: "" },
          mergeable: state !== "dirty",
          mergeable_state: state,
          user: pr.user,
        },
        repository: { full_name: repo },
        sender: pr.user,
      },
      config,
    );

    if (!notification) continue;

    log(`PR #${pr.number} is ${state} — notifying Claude`);
    try {
      await notify(notification, { repo, branch: pr.head.ref });
    } catch (err) {
      log(`Failed to notify for PR #${pr.number}:`, err);
    }
  }
}

export type ReviewPayload = {
  reviewEvent: ReviewEventRecord;
  prMeta: { prNumber: number; prTitle: string; prUrl: string; repo: string };
};

/**
 * Parse a PR review / comment webhook payload into a ReviewEventRecord + PR metadata.
 * Returns null for events we do not act on.
 */
export function parseReviewWebhookPayload(
  event: string,
  action: string | undefined,
  payload: GitHubWebhookPayload,
): ReviewPayload | null {
  const repo = payload.repository?.full_name ?? "unknown";

  if (event === "pull_request_review" && action === "submitted") {
    const review = payload.review as PRReview | undefined;
    const pr = payload.pull_request;
    if (!review || !pr || review.state === "pending") return null;
    return {
      reviewEvent: {
        type: "review",
        reviewer: review.user.login,
        state: review.state,
        body: sanitizeBody(review.body ?? "(no review body)"),
        url: review.html_url,
      },
      prMeta: {
        prNumber: pr.number,
        prTitle: sanitizeBody(pr.title ?? "", 200),
        prUrl: pr.html_url,
        repo,
      },
    };
  }

  if (event === "pull_request_review_comment" && action === "created") {
    const comment = payload.comment as PRReviewComment | undefined;
    const pr = payload.pull_request;
    if (!comment || !pr) return null;
    return {
      reviewEvent: {
        type: "review_comment",
        reviewer: comment.user.login,
        body: sanitizeBody(comment.body),
        url: comment.html_url,
        path: comment.path,
      },
      prMeta: {
        prNumber: pr.number,
        prTitle: sanitizeBody(pr.title ?? "", 200),
        prUrl: pr.html_url,
        repo,
      },
    };
  }

  if (event === "issue_comment" && action === "created") {
    const comment = payload.comment as IssueComment | undefined;
    const issue = payload.issue;
    // issue_comment also fires on plain issues — only act on PR comments
    if (!comment || !issue?.pull_request) return null;
    return {
      reviewEvent: {
        type: "issue_comment",
        reviewer: comment.user.login,
        body: sanitizeBody(comment.body),
        url: comment.html_url,
      },
      prMeta: {
        prNumber: issue.number,
        prTitle: sanitizeBody(issue.title ?? "", 200),
        prUrl: issue.html_url,
        repo,
      },
    };
  }

  if (event === "pull_request_review_thread" && action === "unresolved") {
    const thread = payload.thread;
    const pr = payload.pull_request;
    const firstComment = thread?.comments[0];
    if (!thread || !pr || !firstComment) return null;
    return {
      reviewEvent: {
        type: "unresolved_thread",
        reviewer: payload.sender?.login ?? firstComment.user.login,
        body: sanitizeBody(firstComment.body),
        url: firstComment.html_url,
        path: firstComment.path,
      },
      prMeta: {
        prNumber: pr.number,
        prTitle: sanitizeBody(pr.title ?? "", 200),
        prUrl: pr.html_url,
        repo,
      },
    };
  }

  return null;
}

// ── Actionable Event Filter ───────────────────────────────────────────────────
export function isActionable(event: string, payload: GitHubWebhookPayload): boolean {
  if (event === "ping") return false;

  if (event === "pull_request") {
    const state = payload.pull_request?.mergeable_state;
    // Only act when GitHub has finished computing mergeability
    return (
      ["opened", "synchronize", "reopened"].includes(payload.action ?? "") &&
      (state === "dirty" || state === "behind")
    );
  }

  if (event === "push") return true; // handled separately — no action field

  return (CI_EVENTS.has(event) || event === "check_run") && payload.action === "completed";
}

// ── MCP Server ────────────────────────────────────────────────────────────────
export function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "github-ci-channel", version: "1.0.0" },
    { capabilities: { experimental: { "claude/channel": {} } } },
  );

  mcp.tool(
    "fetch_workflow_logs",
    "Fetch logs for a GitHub Actions workflow run. Use when a CI failure notification arrives and you need to diagnose the root cause.",
    {
      run_url: z
        .string()
        .describe("GitHub Actions run URL (e.g. https://github.com/owner/repo/actions/runs/12345)"),
    },
    async ({ run_url }) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        return {
          content: [{ type: "text" as const, text: "GITHUB_TOKEN not set — cannot fetch logs." }],
        };
      }

      const match = run_url.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
      if (!match) {
        return {
          content: [{ type: "text" as const, text: `Could not parse run URL: ${run_url}` }],
        };
      }

      const [, owner, repo, runId] = match;
      try {
        // Step 1: authenticated request to GitHub — manual redirect so the token
        // is NOT forwarded to the presigned S3 URL GitHub redirects to.
        const apiResp = await fetchWithTimeout(
          `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            redirect: "manual",
          },
          60_000,
        );

        let logsResp: Response;
        if (apiResp.status === 302 || apiResp.status === 301) {
          // Step 2: fetch the presigned URL without Authorization — forwarding a PAT
          // to S3 (or any non-GitHub host) is unnecessary and a token-exposure risk.
          const location = apiResp.headers.get("location");
          if (!location) {
            return {
              content: [
                { type: "text" as const, text: "GitHub redirected without a location header" },
              ],
            };
          }
          logsResp = await fetchWithTimeout(location, {}, 60_000);
        } else {
          logsResp = apiResp;
        }

        if (!logsResp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `GitHub API error: ${logsResp.status} ${logsResp.statusText}`,
              },
            ],
          };
        }

        const text = await logsResp.text();
        const truncated =
          text.length > MAX_LOG_CHARS ? `...(truncated)\n${text.slice(-MAX_LOG_CHARS)}` : text;
        return { content: [{ type: "text" as const, text: truncated }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Fetch failed: ${String(err)}` }],
        };
      }
    },
  );

  return mcp;
}

export async function sendChannelNotification(
  mcp: McpServer,
  notification: CINotification,
): Promise<void> {
  await mcp.server.notification({
    method: "notifications/claude/channel",
    params: {
      channel: "github-ci",
      content: notification.summary,
      meta: notification.meta,
    },
  });
  log(
    `Pushed to Claude: ${notification.meta.event ?? notification.meta.status ?? notification.meta.mergeable_state} on ${notification.meta.repo}`,
  );
}

/**
 * Extract a routing key from a raw webhook event so the mux knows which
 * sessions should receive the resulting notification.
 *
 * - workflow_run  → branch the run executed on
 * - pull_request / review events → PR head branch
 * - push         → pushed branch (but push events are handled separately
 *                  because they trigger async PR-status checks)
 * - everything else → broadcast (branch = null)
 */
export function extractEventRouting(event: string, payload: GitHubWebhookPayload): RoutingKey {
  const repo = payload.repository?.full_name ?? "unknown";

  if (event === "workflow_run") {
    return { repo, branch: payload.workflow_run?.head_branch ?? null };
  }

  if (event === "pull_request" || REVIEW_EVENTS.has(event)) {
    return { repo, branch: payload.pull_request?.head.ref ?? null };
  }

  return { repo, branch: null };
}

/** Returns a skip response if the event or repo is not in the configured allowlists, null otherwise. */
function applyWebhookFilters(
  event: string,
  payloadRepo: string | undefined,
  config: Config,
): Response | null {
  if (
    config.webhooks.allowed_events.length > 0 &&
    !config.webhooks.allowed_events.includes(event)
  ) {
    log(`Skipping event "${event}" — not in allowed_events`);
    return new Response("Skipped", { status: 200 });
  }
  if (
    config.webhooks.allowed_repos.length > 0 &&
    payloadRepo &&
    !config.webhooks.allowed_repos.includes(payloadRepo)
  ) {
    log(`Skipping repo "${payloadRepo}" — not in allowed_repos`);
    return new Response("Skipped", { status: 200 });
  }
  return null;
}

// ── Author Allow-list ─────────────────────────────────────────────────────────

/**
 * Returns true if the PR author's GitHub login matches any username entry
 * (entries without "@") in allowed_authors. Case-sensitive to match GitHub.
 */
export function isAuthorAllowed(prAuthorLogin: string, allowedAuthors: string[]): boolean {
  return allowedAuthors.filter((a) => !a.includes("@")).includes(prAuthorLogin);
}

/**
 * Fetches PR commits via the GitHub API and checks whether any Co-Authored-By
 * trailer contains an email present in allowed_authors.
 *
 * Used as a fallback when isAuthorAllowed() returns false — covers the case
 * where a bot (e.g. Devin) is the PR author but a human is the co-author.
 * Returns false immediately if no email entries are configured.
 */
export async function isCoAuthorAllowed(
  repo: string,
  prNumber: number,
  token: string,
  allowedAuthors: string[],
): Promise<boolean> {
  const emails = allowedAuthors.filter((a) => a.includes("@")).map((e) => e.toLowerCase());
  if (emails.length === 0) return false;

  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/commits`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    10_000,
  );
  if (!resp.ok) return false;

  const commits = (await resp.json()) as Array<{ commit: { message: string } }>;
  const coAuthorRe = /^Co-Authored-By:.*<([^>]+)>/gim;
  for (const { commit } of commits) {
    for (const match of commit.message.matchAll(coAuthorRe)) {
      if (emails.includes(match[1]?.toLowerCase() ?? "")) return true;
    }
  }
  return false;
}

/**
 * Returns true if the PR referenced by this webhook payload is authored (or co-authored)
 * by someone in allowed_authors. Co-author lookup requires a GITHUB_TOKEN and is only
 * attempted when no username entry matched.
 */

async function isPRAllowed(
  payload: GitHubWebhookPayload,
  allowedAuthors: string[],
): Promise<boolean> {
  const prAuthorLogin = payload.pull_request?.user.login ?? "";
  if (isAuthorAllowed(prAuthorLogin, allowedAuthors)) return true;

  const prNumber = payload.pull_request?.number;
  const repo = payload.repository?.full_name ?? "";
  const token = process.env.GITHUB_TOKEN;
  if (token && prNumber !== undefined) {
    return isCoAuthorAllowed(repo, prNumber, token, allowedAuthors);
  }
  return false;
}

/** Log why parseReviewWebhookPayload returned null for a given event. */
function logReviewSkipReason(event: string, payload: GitHubWebhookPayload): void {
  let hint = "";
  if (event === "pull_request_review") {
    const state = (payload.review as { state?: string } | undefined)?.state ?? "?";
    hint = ` (review.state=${state}; need submitted+non-pending)`;
  } else if (event === "issue_comment") {
    const hasPR = !!(payload.issue as { pull_request?: unknown } | undefined)?.pull_request;
    hint = ` (issue.pull_request present: ${hasPR}; need PR comment, not issue comment)`;
  }
  log(`[skip] ${event}/${payload.action ?? "?"} — parseReviewWebhookPayload returned null${hint}`);
}

// ── HTTP Webhook Server ───────────────────────────────────────────────────────

/**
 * Start the HTTP webhook receiver.
 *
 * @param notify  Called for every actionable event. In standalone mode this
 *                pushes to the embedded MCP session; in mux mode it routes to
 *                connected HTTP sessions.
 */
export function startWebhookServer(
  notify: NotifyFn,
  config: Config = DEFAULT_CONFIG,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.server.port,
    async fetch(req) {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ status: "ok", server: "github-ci-channel" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = await req.text();

      if (isOversized(body)) {
        log("Rejected oversized payload");
        return new Response("Payload too large", { status: 413 });
      }

      const signature = req.headers.get("x-hub-signature-256");

      if (!verifySignature(body, signature)) {
        log("Signature verification failed");
        return new Response("Unauthorized", { status: 401 });
      }

      const event = req.headers.get("x-github-event") ?? "unknown";
      const deliveryId = req.headers.get("x-github-delivery") ?? "";

      if (isDuplicateDelivery(deliveryId)) {
        log(`Duplicate delivery ${deliveryId} — skipping`);
        return new Response("OK", { status: 200 });
      }

      if (event === "ping") {
        log("Ping received — webhook configured successfully");
        return new Response("pong", { status: 200 });
      }

      let payload: GitHubWebhookPayload;
      try {
        payload = JSON.parse(body) as GitHubWebhookPayload;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const payloadRepo = payload.repository?.full_name;
      const filterResp = applyWebhookFilters(event, payloadRepo, config);
      if (filterResp) return filterResp;

      log(`Received: ${event} (${payload.action ?? "no action"}) delivery=${deliveryId}`);

      if (event === "push") {
        const push = payload as unknown as GitHubPushPayload;
        const branch = push.ref.replace("refs/heads/", "");
        const token = process.env.GITHUB_TOKEN;
        const mainBranches = new Set(config.server.main_branches);
        if (!mainBranches.has(branch)) {
          log(
            `[skip] push to "${branch}" — not a main branch (${[...mainBranches].join(", ")}) — PR checks skipped`,
          );
        } else if (!token) {
          log(`[skip] push to "${branch}" — GITHUB_TOKEN not set — PR checks skipped`);
        } else {
          log(`Push to ${branch} — checking open PRs for merge status`);
          void checkPRsAfterPush(push.repository.full_name, branch, token, notify, config);
        }
        return new Response("OK", { status: 200 });
      }

      // ── PR Review / Comment events (debounced) ──────────────────────────────
      if (REVIEW_EVENTS.has(event)) {
        const parsed = parseReviewWebhookPayload(event, payload.action, payload);
        if (parsed) {
          const { reviewEvent, prMeta } = parsed;
          const repo = prMeta.repo;
          const key = `${repo}/${prMeta.prNumber}`;
          const routing = extractEventRouting(event, payload);
          const accepted = scheduleReviewNotification(
            key,
            prMeta,
            reviewEvent,
            async (evts, meta) => {
              const notification = buildReviewNotification(evts, meta, config);
              try {
                await notify(notification, routing);
                log(
                  `PR review notification sent for PR #${meta.prNumber} (${evts.length} event(s))`,
                );
              } catch (err) {
                log(`Failed to send PR review notification for PR #${meta.prNumber}:`, err);
              }
            },
            {
              debounceMs: config.server.debounce_ms,
              cooldownMs: config.server.cooldown_ms,
              maxEvents: config.server.max_events_per_window,
            },
          );
          if (!accepted) log(`PR #${prMeta.prNumber} review event discarded (cooldown active)`);
        } else {
          logReviewSkipReason(event, payload);
        }
        return new Response("OK", { status: 200 });
      }

      if (!isActionable(event, payload)) {
        log(`Skipping non-actionable event: ${event}/${payload.action ?? ""}`);
        return new Response("Skipped", { status: 200 });
      }

      if (
        event === "pull_request" &&
        !(await isPRAllowed(payload, config.webhooks.allowed_authors))
      ) {
        log(
          `Skipping pull_request — PR author "${payload.pull_request?.user.login}" not in allowed_authors`,
        );
        return new Response("Skipped", { status: 200 });
      }

      const notification =
        event === "pull_request"
          ? parsePullRequestEvent(payload, config)
          : parseWorkflowEvent(event, payload, config);

      if (!notification) {
        // parse functions log the specific reason — this is just the outer guard
        log(`[skip] ${event}/${payload.action ?? "?"}: parse returned null (see reason above)`);
        return new Response("OK", { status: 200 });
      }

      const routing = extractEventRouting(event, payload);
      try {
        await notify(notification, routing);
      } catch (err) {
        log("Failed to send notification:", err);
        return new Response("Notification failed", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    },
  });
}

/**
 * Returns a human-readable label for a GitHub webhook event type.
 * Used in notification summaries.
 */
export function getEventLabel(event: string): string {
  const labels: Record<string, string> = {
    workflow_run: "CI Workflow",
    workflow_job: "CI Job",
    check_suite: "Check Suite",
    pull_request: "Pull Request",
    pull_request_review: "PR Review",
    pull_request_review_comment: "PR Review Comment",
    push: "Push",
    issue_comment: "Issue Comment",
  };
  return labels[event] ?? event;
}
