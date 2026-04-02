import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CINotification, GitHubWebhookPayload } from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.WEBHOOK_PORT ?? "9443", 10);
const MAX_LOG_CHARS = 8000;
const MAIN_BRANCHES = new Set(["main", "master"]);

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
          "🚨 Main branch is broken. Spawn a subagent to:",
          "  1. Read the logs above",
          "  2. Find the failing step and root cause",
          "  3. Apply a fix and push to restore main",
        );
      } else {
        lines.push(
          "",
          "Spawn a subagent to investigate, then fix the failing step and push an update.",
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

  // Fallback for unknown events
  return {
    summary: `GitHub event "${event}": ${JSON.stringify(payload).slice(0, MAX_LOG_CHARS)}`,
    meta: { source: "github-ci", event, action: payload.action ?? "" },
  };
}

export function parsePullRequestEvent(payload: GitHubWebhookPayload): CINotification | null {
  const pr = payload.pull_request;
  if (!pr) return null;

  const repo = payload.repository?.full_name ?? "unknown";
  const state = pr.mergeable_state;

  if (state === "dirty") {
    return {
      summary: [
        `⚠️ MERGE CONFLICT — PR #${pr.number}: "${pr.title}"`,
        `Repo: ${repo} | Branch: ${pr.head.ref} → ${pr.base.ref}`,
        `URL: ${pr.html_url}`,
        "",
        `This PR has conflicts with ${pr.base.ref}.`,
        "Spawn a subagent to resolve them:",
        `  git checkout ${pr.head.ref}`,
        `  git rebase origin/${pr.base.ref}`,
        "  # resolve conflicts, then:",
        "  git push --force-with-lease",
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
        `${pr.head.ref} is behind ${pr.base.ref} (no conflicts, just needs a rebase).`,
        "Spawn a subagent to update it:",
        `  git checkout ${pr.head.ref}`,
        `  git rebase origin/${pr.base.ref}`,
        "  git push --force-with-lease",
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
