import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildReviewNotification,
  isActionable,
  isDuplicateDelivery,
  isInReviewCooldown,
  isOversized,
  parseWorkflowEvent,
  pendingReviews,
  reviewCooldowns,
  sanitizeBody,
  scheduleReviewNotification,
  verifySignature,
} from "../server.js";
import type { GitHubWebhookPayload } from "../types.js";

// ── verifySignature ──────────────────────────────────────────────────────────
describe("verifySignature", () => {
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret-1234";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      process.env.GITHUB_WEBHOOK_SECRET = undefined;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    }
  });

  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const payload = '{"action":"completed"}';
    const { createHmac } = await import("node:crypto");
    const sig = `sha256=${createHmac("sha256", "test-secret-1234").update(payload).digest("hex")}`;
    expect(verifySignature(payload, sig)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const payload = '{"action":"completed"}';
    expect(verifySignature(payload, "sha256=deadbeef")).toBe(false);
  });

  it("returns false when signature is null", () => {
    expect(verifySignature("payload", null)).toBe(false);
  });

  it("returns true (dev mode) when no secret is configured", () => {
    process.env.GITHUB_WEBHOOK_SECRET = undefined;
    expect(verifySignature("anything", null)).toBe(true);
    expect(verifySignature("anything", "wrong-sig")).toBe(true);
  });
});

// ── isActionable ─────────────────────────────────────────────────────────────
describe("isActionable", () => {
  it("returns true for workflow_run completed", () => {
    expect(isActionable("workflow_run", { action: "completed" })).toBe(true);
  });

  it("returns true for workflow_job completed", () => {
    expect(isActionable("workflow_job", { action: "completed" })).toBe(true);
  });

  it("returns true for check_suite completed", () => {
    expect(isActionable("check_suite", { action: "completed" })).toBe(true);
  });

  it("returns false for workflow_run requested (not completed)", () => {
    expect(isActionable("workflow_run", { action: "requested" })).toBe(false);
  });

  it("returns false for workflow_run in_progress", () => {
    expect(isActionable("workflow_run", { action: "in_progress" })).toBe(false);
  });

  it("returns false for ping event", () => {
    expect(isActionable("ping", { action: "completed" })).toBe(false);
  });

  it("returns true for push event (triggers PR check)", () => {
    expect(isActionable("push", {})).toBe(true);
  });

  it("returns false for unknown event", () => {
    expect(isActionable("deployment", { action: "completed" })).toBe(false);
  });
});

// ── parseWorkflowEvent ───────────────────────────────────────────────────────
describe("parseWorkflowEvent", () => {
  const basePayload: GitHubWebhookPayload = {
    action: "completed",
    repository: { full_name: "acme/myrepo" },
    sender: { login: "octocat" },
  };

  describe("workflow_run", () => {
    it("formats a successful run correctly", () => {
      const payload: GitHubWebhookPayload = {
        ...basePayload,
        workflow_run: {
          name: "CI",
          conclusion: "success",
          status: "completed",
          head_branch: "main",
          run_number: 42,
          html_url: "https://github.com/acme/myrepo/actions/runs/1",
          run_started_at: "2026-04-01T10:00:00Z",
          updated_at: "2026-04-01T10:01:30Z",
          head_commit: { message: "Fix the thing\n\nLonger description" },
        },
      };

      const result = parseWorkflowEvent("workflow_run", payload);
      expect(result).not.toBeNull();
      expect(result?.summary).toContain("✅");
      expect(result?.summary).toContain("SUCCESS");
      expect(result?.summary).toContain("CI");
      expect(result?.summary).toContain("acme/myrepo");
      expect(result?.summary).toContain("main");
      expect(result?.summary).toContain("Fix the thing");
      expect(result?.summary).toContain("90s");
      expect(result?.summary).toContain("#42");
      expect(result?.meta.status).toBe("success");
      expect(result?.meta.branch).toBe("main");
    });

    it("includes failure diagnosis hint for failed runs", () => {
      const payload: GitHubWebhookPayload = {
        ...basePayload,
        workflow_run: {
          name: "CI",
          conclusion: "failure",
          status: "completed",
          head_branch: "feature/x",
          run_number: 7,
          html_url: "https://github.com/acme/myrepo/actions/runs/2",
          run_started_at: null,
          updated_at: null,
        },
      };

      const result = parseWorkflowEvent("workflow_run", payload);
      expect(result?.summary).toContain("❌");
      expect(result?.summary).toContain("FAILURE");
      expect(result?.summary).toContain("fetch_workflow_logs");
      expect(result?.meta.status).toBe("failure");
    });

    it("uses cancelled emoji for cancelled runs", () => {
      const payload: GitHubWebhookPayload = {
        ...basePayload,
        workflow_run: {
          name: "CI",
          conclusion: "cancelled",
          status: "completed",
          head_branch: "main",
          run_number: 1,
          html_url: "https://github.com/acme/myrepo/actions/runs/3",
          run_started_at: null,
          updated_at: null,
        },
      };
      const result = parseWorkflowEvent("workflow_run", payload);
      expect(result?.summary).toContain("⚠️");
    });

    it("returns null when workflow_run is missing from payload", () => {
      expect(parseWorkflowEvent("workflow_run", basePayload)).toBeNull();
    });
  });

  describe("workflow_job", () => {
    it("formats a failed job with failed steps", () => {
      const payload: GitHubWebhookPayload = {
        ...basePayload,
        workflow_job: {
          name: "build",
          conclusion: "failure",
          status: "completed",
          html_url: "https://github.com/acme/myrepo/actions/runs/1/jobs/9",
          runner_name: "ubuntu-latest",
          labels: ["ubuntu-latest"],
          steps: [
            { name: "Checkout", conclusion: "success" },
            { name: "Run tests", conclusion: "failure" },
            { name: "Upload artifacts", conclusion: "skipped" },
          ],
        },
      };

      const result = parseWorkflowEvent("workflow_job", payload);
      expect(result?.summary).toContain("❌");
      expect(result?.summary).toContain("build");
      expect(result?.summary).toContain("Run tests");
      expect(result?.meta.job_name).toBe("build");
    });

    it("returns null for non-completed workflow_job", () => {
      const payload = { ...basePayload, action: "queued" };
      expect(parseWorkflowEvent("workflow_job", payload)).toBeNull();
    });
  });

  describe("check_suite / check_run", () => {
    it("formats check_suite completion", () => {
      const payload: GitHubWebhookPayload = {
        ...basePayload,
        check_suite: { conclusion: "success", app: { name: "GitHub Actions" } },
      };
      const result = parseWorkflowEvent("check_suite", payload);
      expect(result?.summary).toContain("✅");
      expect(result?.summary).toContain("check_suite");
    });

    it("returns null for non-completed check events", () => {
      const payload = { ...basePayload, action: "created", check_suite: { conclusion: null } };
      expect(parseWorkflowEvent("check_suite", payload)).toBeNull();
    });
  });

  describe("unknown events", () => {
    it("returns a fallback notification for unknown event types", () => {
      const result = parseWorkflowEvent("push", basePayload);
      expect(result).not.toBeNull();
      expect(result?.summary).toContain("push");
      expect(result?.meta.event).toBe("push");
    });
  });
});

// ── parsePullRequestEvent ─────────────────────────────────────────────────────
import { parsePullRequestEvent } from "../server.js";
import type { PullRequest } from "../types.js";

const basePR: PullRequest = {
  number: 42,
  title: "feat: add new widget",
  state: "open",
  html_url: "https://github.com/acme/myrepo/pull/42",
  head: { ref: "feature/widget", sha: "abc123" },
  base: { ref: "main", sha: "def456" },
  mergeable: false,
  mergeable_state: "dirty",
  user: { login: "octocat" },
};

const prPayload: GitHubWebhookPayload = {
  action: "synchronize",
  number: 42,
  repository: { full_name: "acme/myrepo" },
  sender: { login: "octocat" },
  pull_request: basePR,
};

describe("parsePullRequestEvent", () => {
  it("returns conflict notification for dirty PR", () => {
    const result = parsePullRequestEvent(prPayload);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain("MERGE CONFLICT");
    expect(result?.summary).toContain("PR #42");
    expect(result?.summary).toContain("feat: add new widget");
    expect(result?.summary).toContain("feature/widget");
    expect(result?.summary).toContain("rebase");
    expect(result?.meta.mergeable_state).toBe("dirty");
    expect(result?.meta.pr_number).toBe("42");
  });

  it("returns rebase notification for behind PR", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      pull_request: { ...basePR, mergeable_state: "behind", mergeable: null },
    };
    const result = parsePullRequestEvent(payload);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain("BRANCH BEHIND BASE");
    expect(result?.summary).toContain("rebase");
    expect(result?.meta.mergeable_state).toBe("behind");
  });

  it("returns null for clean PR", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      pull_request: { ...basePR, mergeable_state: "clean", mergeable: true },
    };
    expect(parsePullRequestEvent(payload)).toBeNull();
  });

  it("returns null when pull_request is missing", () => {
    expect(parsePullRequestEvent({ action: "synchronize" })).toBeNull();
  });
});

// ── isActionable — pull_request ───────────────────────────────────────────────
describe("isActionable — pull_request events", () => {
  it("returns true for synchronize with dirty state", () => {
    expect(isActionable("pull_request", prPayload)).toBe(true);
  });

  it("returns true for opened with behind state", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      action: "opened",
      pull_request: { ...basePR, mergeable_state: "behind" },
    };
    expect(isActionable("pull_request", payload)).toBe(true);
  });

  it("returns false for clean PR", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      pull_request: { ...basePR, mergeable_state: "clean", mergeable: true },
    };
    expect(isActionable("pull_request", payload)).toBe(false);
  });

  it("returns false for closed action", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      action: "closed",
    };
    expect(isActionable("pull_request", payload)).toBe(false);
  });

  it("returns false for unknown mergeable_state (still computing)", () => {
    const payload: GitHubWebhookPayload = {
      ...prPayload,
      pull_request: { ...basePR, mergeable_state: "unknown", mergeable: null },
    };
    expect(isActionable("pull_request", payload)).toBe(false);
  });
});

// ── parseWorkflowEvent — main branch failure ──────────────────────────────────
describe("parseWorkflowEvent — main branch escalation", () => {
  it("includes subagent spawn instruction for failures on main", () => {
    const payload: GitHubWebhookPayload = {
      action: "completed",
      repository: { full_name: "acme/myrepo" },
      sender: { login: "octocat" },
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        status: "completed",
        head_branch: "main",
        run_number: 10,
        html_url: "https://github.com/acme/myrepo/actions/runs/10",
        run_started_at: null,
        updated_at: null,
      },
    };
    const result = parseWorkflowEvent("workflow_run", payload);
    expect(result?.summary).toContain("Main branch is broken");
    expect(result?.summary).toContain("Agent tool NOW");
  });

  it("does not escalate for failures on feature branches", () => {
    const payload: GitHubWebhookPayload = {
      action: "completed",
      repository: { full_name: "acme/myrepo" },
      sender: { login: "octocat" },
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        status: "completed",
        head_branch: "feature/cool",
        run_number: 11,
        html_url: "https://github.com/acme/myrepo/actions/runs/11",
        run_started_at: null,
        updated_at: null,
      },
    };
    const result = parseWorkflowEvent("workflow_run", payload);
    expect(result?.summary).not.toContain("Main branch is broken");
    expect(result?.summary).toContain("Agent tool NOW");
  });
});

// ── buildReviewNotification ───────────────────────────────────────────────────
describe("buildReviewNotification", () => {
  const meta = {
    prNumber: 42,
    prTitle: "feat: add rate limiting",
    prUrl: "https://github.com/acme/repo/pull/42",
    repo: "acme/repo",
  };

  it("includes PR number and title in summary", () => {
    const events = [
      {
        type: "review" as const,
        reviewer: "alice",
        state: "CHANGES_REQUESTED" as const,
        body: "Please add tests.",
        url: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.summary).toContain("PR #42");
    expect(result.summary).toContain("feat: add rate limiting");
  });

  it("groups events by reviewer", () => {
    const events = [
      {
        type: "review" as const,
        reviewer: "alice",
        state: "CHANGES_REQUESTED" as const,
        body: "Needs error handling.",
        url: "https://github.com/acme/repo/pull/42#r1",
      },
      {
        type: "review_comment" as const,
        reviewer: "bob",
        body: "Consider a Map here.",
        url: "https://github.com/acme/repo/pull/42#r2",
        path: "src/server.ts",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.summary).toContain("@alice");
    expect(result.summary).toContain("@bob");
    expect(result.summary).toContain("CHANGES_REQUESTED");
  });

  it("includes file path for line-level comments", () => {
    const events = [
      {
        type: "review_comment" as const,
        reviewer: "carol",
        body: "Missing null check.",
        url: "https://github.com/acme/repo/pull/42#r3",
        path: "src/index.ts",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.summary).toContain("src/index.ts");
  });

  it("includes plan mode and skill instruction", () => {
    const events = [
      {
        type: "issue_comment" as const,
        reviewer: "dave",
        body: "LGTM overall.",
        url: "https://github.com/acme/repo/pull/42#issuecomment-1",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.summary).toContain("plan mode");
    expect(result.summary).toContain("pr-comment-response");
  });

  it("marks unresolved_thread events with re-opened prefix", () => {
    const events = [
      {
        type: "unresolved_thread" as const,
        reviewer: "alice",
        body: "This still needs fixing.",
        url: "https://github.com/acme/repo/pull/42#discussion_r1",
        path: "src/server.ts",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.summary).toContain("🔄 re-opened");
    expect(result.summary).toContain("src/server.ts");
  });

  it("sets correct meta fields", () => {
    const events = [
      {
        type: "review" as const,
        reviewer: "alice",
        state: "APPROVED" as const,
        body: "Ship it!",
        url: "https://github.com/acme/repo/pull/42#r4",
      },
    ];
    const result = buildReviewNotification(events, meta);
    expect(result.meta.event).toBe("pr_review");
    expect(result.meta.pr_number).toBe("42");
    expect(result.meta.event_count).toBe("1");
  });
});

// ── scheduleReviewNotification / debounce ─────────────────────────────────────
describe("scheduleReviewNotification — debounce", () => {
  beforeEach(() => {
    pendingReviews.clear();
    reviewCooldowns.clear();
  });

  afterEach(() => {
    // Clean up any lingering timers
    for (const entry of pendingReviews.values()) clearTimeout(entry.timer);
    pendingReviews.clear();
    reviewCooldowns.clear();
  });

  const meta = {
    prNumber: 1,
    prTitle: "test PR",
    prUrl: "https://github.com/acme/repo/pull/1",
    repo: "acme/repo",
  };
  const event = {
    type: "review" as const,
    reviewer: "alice",
    state: "COMMENTED" as const,
    body: "nit",
    url: "https://github.com/acme/repo/pull/1#r1",
  };

  it("returns true and adds to pending map", () => {
    const accepted = scheduleReviewNotification("acme/repo/1", meta, event, () => {});
    expect(accepted).toBe(true);
    expect(pendingReviews.has("acme/repo/1")).toBe(true);
  });

  it("accumulates multiple events under the same key", () => {
    scheduleReviewNotification("acme/repo/1", meta, event, () => {});
    const event2 = { ...event, reviewer: "bob", url: "https://github.com/acme/repo/pull/1#r2" };
    scheduleReviewNotification("acme/repo/1", meta, event2, () => {});
    expect(pendingReviews.get("acme/repo/1")?.events).toHaveLength(2);
  });

  it("accepts unresolved_thread events into the debounce queue", () => {
    const unresolvedEvent = {
      type: "unresolved_thread" as const,
      reviewer: "alice",
      body: "Still not addressed.",
      url: "https://github.com/acme/repo/pull/1#discussion_r1",
      path: "src/index.ts",
    };
    scheduleReviewNotification("acme/repo/1", meta, unresolvedEvent, () => {});
    const entry = pendingReviews.get("acme/repo/1");
    expect(entry).toBeDefined();
    expect(entry?.events[0]?.type).toBe("unresolved_thread");
  });

  it("returns false and discards when key is in cooldown", () => {
    reviewCooldowns.set("acme/repo/1", Date.now() + 60_000);
    const accepted = scheduleReviewNotification("acme/repo/1", meta, event, () => {});
    expect(accepted).toBe(false);
    expect(pendingReviews.has("acme/repo/1")).toBe(false);
  });
});

// ── isInReviewCooldown ────────────────────────────────────────────────────────
describe("isInReviewCooldown", () => {
  beforeEach(() => reviewCooldowns.clear());
  afterEach(() => reviewCooldowns.clear());

  it("returns false when no cooldown is set", () => {
    expect(isInReviewCooldown("x/y/1")).toBe(false);
  });

  it("returns true when cooldown has not expired", () => {
    reviewCooldowns.set("x/y/1", Date.now() + 60_000);
    expect(isInReviewCooldown("x/y/1")).toBe(true);
  });

  it("returns false and cleans up when cooldown has expired", () => {
    reviewCooldowns.set("x/y/1", Date.now() - 1);
    expect(isInReviewCooldown("x/y/1")).toBe(false);
    expect(reviewCooldowns.has("x/y/1")).toBe(false);
  });
});

// ── isOversized ───────────────────────────────────────────────────────────────
describe("isOversized", () => {
  it("returns false for a normal-sized payload", () => {
    expect(isOversized('{"action":"completed"}')).toBe(false);
  });

  it("returns true when body exceeds 10 MB", () => {
    expect(isOversized("x".repeat(10 * 1024 * 1024 + 1))).toBe(true);
  });
});

// ── isDuplicateDelivery ───────────────────────────────────────────────────────
describe("isDuplicateDelivery", () => {
  it("returns false for a new delivery ID", () => {
    expect(isDuplicateDelivery(`unique-id-${Date.now()}`)).toBe(false);
  });

  it("returns true for a repeated delivery ID", () => {
    const id = `replay-${Math.random()}`;
    isDuplicateDelivery(id);
    expect(isDuplicateDelivery(id)).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isDuplicateDelivery("")).toBe(false);
  });
});

// ── sanitizeBody ──────────────────────────────────────────────────────────────
describe("sanitizeBody", () => {
  it("removes null bytes", () => {
    const nul = String.fromCharCode(0);
    expect(sanitizeBody(`hello${nul}world`)).toBe("helloworld");
  });

  it("collapses newlines and tabs to a single space", () => {
    expect(sanitizeBody("line1\nline2\ttab")).toBe("line1 line2 tab");
  });

  it("truncates to maxLen", () => {
    expect(sanitizeBody("a".repeat(600))).toHaveLength(500);
    expect(sanitizeBody("a".repeat(10), 5)).toHaveLength(5);
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeBody("  hello  ")).toBe("hello");
  });
});
