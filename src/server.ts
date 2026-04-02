import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  CINotification,
  GitHubPushPayload,
  GitHubWebhookPayload,
  IssueComment,
  MergeableState,
  PRReview,
  PRReviewComment,
} from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.WEBHOOK_PORT ?? "9443", 10);
const MAX_LOG_CHARS = 8000;
const MAIN_BRANCHES = new Set(["main", "master"]);

// ── PR Review Debounce ────────────────────────────────────────────────────────
const REVIEW_DEBOUNCE_MS = Number.parseInt(process.env.REVIEW_DEBOUNCE_MS ?? "30000", 10);
const REVIEW_COOLDOWN_MS = 5 * 60 * 1000; // 5 min — discard events after a notification fires

export interface ReviewEventRecord {
  type: "review" | "review_comment" | "issue_comment" | "unresolved_thread";
  reviewer: string;
  /** Uppercase review state, e.g. CHANGES_REQUESTED */
  state?: string;
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
 * a 5-minute cooldown is set for the key so subsequent bursts are dropped.
 */
export function scheduleReviewNotification(
  key: string,
  prMeta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
  event: ReviewEventRecord,
  onFire: (
    events: ReviewEventRecord[],
    meta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
  ) => void,
): boolean {
  if (isInReviewCooldown(key)) return false;

  const existing = pendingReviews.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.events.push(event);
    existing.timer = setTimeout(() => {
      const entry = pendingReviews.get(key);
      pendingReviews.delete(key);
      reviewCooldowns.set(key, Date.now() + REVIEW_COOLDOWN_MS);
      if (entry) onFire(entry.events, prMeta);
    }, REVIEW_DEBOUNCE_MS);
  } else {
    const entry: PendingPRReview = {
      ...prMeta,
      events: [event],
      timer: setTimeout(() => {
        pendingReviews.delete(key);
        reviewCooldowns.set(key, Date.now() + REVIEW_COOLDOWN_MS);
        onFire(entry.events, prMeta);
      }, REVIEW_DEBOUNCE_MS),
    };
    pendingReviews.set(key, entry);
  }
  return true;
}

export function buildReviewNotification(
  events: ReviewEventRecord[],
  meta: { prNumber: number; prTitle: string; prUrl: string; repo: string },
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
      const snippet = ev.body.replace(/\n/g, " ").slice(0, 120);
      const location = ev.path ? ` (${ev.path})` : "";
      const prefix = ev.type === "unresolved_thread" ? "🔄 re-opened" : "•";
      lines.push(`  ${prefix} "${snippet}"${location}`);
      lines.push(`    → ${ev.url}`);
    }
  }

  lines.push(
    "",
    "Act immediately — no confirmation needed.",
    "Enter plan mode, then use the pr-comment-response skill to address each thread.",
    "",
    "Subagent instructions:",
    `1. For each comment thread above, open the link and read full context`,
    `2. Code comments: apply the fix in a worktree, commit`,
    `3. Questions / style: reply inline with a concise explanation`,
    `4. Use gh-pr-reply.sh --batch to post all replies in one shot`,
  );

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
    log("WARNING: No GITHUB_WEBHOOK_SECRET set — skipping verification (dev mode)");
    return true;
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
export function parseWorkflowEvent(
  event: string,
  payload: GitHubWebhookPayload,
): CINotification | null {
  const repo = payload.repository?.full_name ?? "unknown";

  if (event === "workflow_run") {
    const run = payload.workflow_run;
    if (!run) return null;

    const status = run.conclusion ?? run.status;
    const emoji = statusEmoji(run.conclusion);
    const commitMsg = run.head_commit?.message?.split("\n")[0] ?? "";
    const duration = formatDuration(run.run_started_at, run.updated_at);
    const isMainBranch = MAIN_BRANCHES.has(run.head_branch);

    const lines = [
      `${emoji} CI ${status.toUpperCase()}: ${run.name} on ${repo}`,
      `Branch: ${run.head_branch} | Commit: "${commitMsg}"`,
      `Duration: ${duration} | Run #${run.run_number}`,
      `URL: ${run.html_url}`,
    ];

    if (status === "failure") {
      lines.push("", "Fetch logs and diagnose:", `  fetch_workflow_logs("${run.html_url}")`);

      if (isMainBranch) {
        lines.push(
          "",
          "🚨 Main branch is broken. Act immediately — no confirmation needed.",
          "Use the Agent tool NOW to spawn a subagent with these instructions:",
          `Diagnose and fix the broken CI on main in ${repo}:`,
          `1. Call fetch_workflow_logs("${run.html_url}") to read the failure`,
          "2. Identify the failing step and root cause",
          "3. Apply a targeted fix in the codebase",
          "4. Commit and push to restore main",
          "5. Confirm CI is green.",
        );
      } else {
        lines.push(
          "",
          "Act immediately — no confirmation needed.",
          "Use the Agent tool NOW to spawn a subagent with these instructions:",
          `Investigate the CI failure on branch ${run.head_branch} in ${repo}:`,
          `1. Call fetch_workflow_logs("${run.html_url}") to read the failure`,
          "2. Identify the root cause and fix it",
          "3. Push the fix to the branch.",
        );
      }
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

  if (event === "workflow_job") {
    const job = payload.workflow_job;
    if (!job || payload.action !== "completed") return null;

    const status = job.conclusion ?? "unknown";
    const emoji = statusEmoji(job.conclusion);
    const failedSteps = (job.steps ?? [])
      .filter((s) => s.conclusion === "failure")
      .map((s) => `  - Step "${s.name}" failed`)
      .join("\n");

    const lines = [
      `${emoji} Job ${status.toUpperCase()}: "${job.name}" in ${repo}`,
      `Runner: ${job.runner_name ?? "unknown"} | Labels: ${(job.labels ?? []).join(", ")}`,
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
    if (!check || payload.action !== "completed") return null;

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

export function parsePullRequestEvent(payload: GitHubWebhookPayload): CINotification | null {
  const pr = payload.pull_request;
  if (!pr) return null;

  const repo = payload.repository?.full_name ?? "unknown";
  const state: MergeableState = pr.mergeable_state;

  if (state === "dirty") {
    return {
      summary: [
        `⚠️ MERGE CONFLICT — PR #${pr.number}: "${pr.title}"`,
        `Repo: ${repo} | Branch: ${pr.head.ref} → ${pr.base.ref}`,
        `URL: ${pr.html_url}`,
        "",
        `PR #${pr.number} has merge conflicts with ${pr.base.ref}. Act immediately — no confirmation needed.`,
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        `Resolve merge conflicts for PR #${pr.number} in ${repo}:`,
        `1. git worktree add /tmp/pr-${pr.number}-rebase ${pr.head.ref}`,
        `2. cd /tmp/pr-${pr.number}-rebase && git fetch origin`,
        `3. git rebase origin/${pr.base.ref} — fix conflicts, then: git add -A && git rebase --continue`,
        `4. git push --force-with-lease origin ${pr.head.ref}`,
        `5. git worktree remove /tmp/pr-${pr.number}-rebase`,
      ].join("\n"),
      meta: {
        source: "github-ci",
        event: "pull_request",
        action: payload.action ?? "",
        repo,
        pr_number: String(pr.number),
        pr_title: pr.title,
        head_branch: pr.head.ref,
        base_branch: pr.base.ref,
        pr_url: pr.html_url,
        mergeable_state: state,
        sender: payload.sender?.login ?? "",
      },
    };
  }

  if (state === "behind") {
    return {
      summary: [
        `⬇️ BRANCH BEHIND BASE — PR #${pr.number}: "${pr.title}"`,
        `Repo: ${repo} | Branch: ${pr.head.ref} → ${pr.base.ref}`,
        `URL: ${pr.html_url}`,
        "",
        `PR #${pr.number} is behind ${pr.base.ref} (no conflicts). Act immediately — no confirmation needed.`,
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        `Rebase PR #${pr.number} in ${repo}:`,
        `1. git worktree add /tmp/pr-${pr.number}-rebase ${pr.head.ref}`,
        `2. cd /tmp/pr-${pr.number}-rebase && git fetch origin`,
        `3. git rebase origin/${pr.base.ref}`,
        `4. git push --force-with-lease origin ${pr.head.ref}`,
        `5. git worktree remove /tmp/pr-${pr.number}-rebase`,
      ].join("\n"),
      meta: {
        source: "github-ci",
        event: "pull_request",
        action: payload.action ?? "",
        repo,
        pr_number: String(pr.number),
        pr_title: pr.title,
        head_branch: pr.head.ref,
        base_branch: pr.base.ref,
        pr_url: pr.html_url,
        mergeable_state: state,
        sender: payload.sender?.login ?? "",
      },
    };
  }

  return null;
}

// ── Push → PR Behind Detection ────────────────────────────────────────────────

async function fetchPRMergeableState(
  repo: string,
  prNumber: number,
  token: string,
): Promise<MergeableState> {
  const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
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
  mcp: McpServer,
): Promise<void> {
  // Give GitHub a moment to start computing mergeability
  await new Promise<void>((r) => setTimeout(r, 4_000));

  const resp = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=open&base=${baseBranch}&per_page=20`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
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
    // Always fetch individual PR — list endpoint omits mergeable_state
    let state = await fetchPRMergeableState(repo, pr.number, token);

    // Retry once if GitHub is still computing (common immediately after a push)
    if (state === "unknown") {
      await new Promise<void>((r) => setTimeout(r, 5_000));
      state = await fetchPRMergeableState(repo, pr.number, token);
    }

    if (state !== "dirty" && state !== "behind") continue;

    const notification = parsePullRequestEvent({
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
    });

    if (!notification) continue;

    log(`PR #${pr.number} is ${state} — notifying Claude`);
    try {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: {
          channel: "github-ci",
          content: notification.summary,
          meta: notification.meta,
        },
      });
    } catch (err) {
      log(`Failed to notify for PR #${pr.number}:`, err);
    }
  }
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

  const completedEvents = ["workflow_run", "workflow_job", "check_suite", "check_run"];
  return completedEvents.includes(event) && payload.action === "completed";
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
        const resp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            redirect: "follow",
          },
        );

        if (!resp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `GitHub API error: ${resp.status} ${resp.statusText}`,
              },
            ],
          };
        }

        const text = await resp.text();
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

// ── HTTP Webhook Server ───────────────────────────────────────────────────────
export function startWebhookServer(mcp: McpServer): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: PORT,
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
      const signature = req.headers.get("x-hub-signature-256");

      if (!verifySignature(body, signature)) {
        log("Signature verification failed");
        return new Response("Unauthorized", { status: 401 });
      }

      const event = req.headers.get("x-github-event") ?? "unknown";
      const deliveryId = req.headers.get("x-github-delivery") ?? "";

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

      log(`Received: ${event} (${payload.action ?? "no action"}) delivery=${deliveryId}`);

      if (event === "push") {
        const push = JSON.parse(body) as GitHubPushPayload;
        const branch = push.ref.replace("refs/heads/", "");
        const token = process.env.GITHUB_TOKEN;
        if (MAIN_BRANCHES.has(branch) && token) {
          log(`Push to ${branch} — checking open PRs for merge status`);
          void checkPRsAfterPush(push.repository.full_name, branch, token, mcp);
        }
        return new Response("OK", { status: 200 });
      }

      // ── PR Review / Comment events (debounced) ──────────────────────────────
      if (
        event === "pull_request_review" ||
        event === "pull_request_review_comment" ||
        event === "pull_request_review_thread" ||
        event === "issue_comment"
      ) {
        let reviewEvent: ReviewEventRecord | null = null;
        let prMeta: { prNumber: number; prTitle: string; prUrl: string; repo: string } | null =
          null;
        const repo = payload.repository?.full_name ?? "unknown";

        if (event === "pull_request_review" && payload.action === "submitted") {
          const review = payload.review as PRReview | undefined;
          const pr = payload.pull_request;
          if (review && pr && (review.state as string) !== "pending") {
            reviewEvent = {
              type: "review",
              reviewer: review.user.login,
              state: review.state,
              body: review.body ?? "(no review body)",
              url: review.html_url,
            };
            prMeta = { prNumber: pr.number, prTitle: pr.title, prUrl: pr.html_url, repo };
          }
        } else if (event === "pull_request_review_comment" && payload.action === "created") {
          const comment = payload.comment as PRReviewComment | undefined;
          const pr = payload.pull_request;
          if (comment && pr) {
            reviewEvent = {
              type: "review_comment",
              reviewer: comment.user.login,
              body: comment.body,
              url: comment.html_url,
              path: comment.path,
            };
            prMeta = { prNumber: pr.number, prTitle: pr.title, prUrl: pr.html_url, repo };
          }
        } else if (event === "issue_comment" && payload.action === "created") {
          const comment = payload.comment as IssueComment | undefined;
          const issue = payload.issue;
          // Only act on PR comments — issue_comment also fires on plain issues
          if (comment && issue?.pull_request) {
            reviewEvent = {
              type: "issue_comment",
              reviewer: comment.user.login,
              body: comment.body,
              url: comment.html_url,
            };
            prMeta = {
              prNumber: issue.number,
              prTitle: issue.title,
              prUrl: issue.html_url,
              repo,
            };
          }
        } else if (event === "pull_request_review_thread" && payload.action === "unresolved") {
          const thread = payload.thread;
          const pr = payload.pull_request;
          // Use the thread's first comment as the representative entry
          const firstComment = thread?.comments[0];
          if (thread && pr && firstComment) {
            reviewEvent = {
              type: "unresolved_thread",
              reviewer: payload.sender?.login ?? firstComment.user.login,
              body: firstComment.body,
              url: firstComment.html_url,
              path: firstComment.path,
            };
            prMeta = { prNumber: pr.number, prTitle: pr.title, prUrl: pr.html_url, repo };
          }
        }

        if (reviewEvent && prMeta) {
          const key = `${repo}/${prMeta.prNumber}`;
          const accepted = scheduleReviewNotification(
            key,
            prMeta,
            reviewEvent,
            async (evts, meta) => {
              const notification = buildReviewNotification(evts, meta);
              try {
                await mcp.server.notification({
                  method: "notifications/claude/channel",
                  params: {
                    channel: "github-ci",
                    content: notification.summary,
                    meta: notification.meta,
                  },
                });
                log(
                  `PR review notification sent for PR #${meta.prNumber} (${evts.length} event(s))`,
                );
              } catch (err) {
                log(`Failed to send PR review notification for PR #${meta.prNumber}:`, err);
              }
            },
          );
          if (!accepted) log(`PR #${prMeta.prNumber} review event discarded (cooldown active)`);
        } else {
          log(`Skipping ${event}/${payload.action ?? ""} — not a PR review we act on`);
        }
        return new Response("OK", { status: 200 });
      }

      if (!isActionable(event, payload)) {
        log(`Skipping non-actionable event: ${event}/${payload.action ?? ""}`);
        return new Response("Skipped", { status: 200 });
      }

      const notification =
        event === "pull_request"
          ? parsePullRequestEvent(payload)
          : parseWorkflowEvent(event, payload);

      if (!notification) {
        return new Response("Unparseable", { status: 200 });
      }

      try {
        await mcp.server.notification({
          method: "notifications/claude/channel",
          params: {
            channel: "github-ci",
            content: notification.summary,
            meta: notification.meta,
          },
        });
        log(
          `Pushed to Claude: ${notification.meta.status ?? notification.meta.mergeable_state} on ${notification.meta.repo}`,
        );
      } catch (err) {
        log("Failed to send notification:", err);
        return new Response("Notification failed", { status: 500 });
      }

      return new Response("OK", { status: 200 });
    },
  });
}

// ── Request Size Guard ────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 25 * 1024; // 25 KB — GitHub webhook payloads are well under this

/** Returns true if the raw body exceeds the allowed limit. */
export function isOversized(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES;
}
