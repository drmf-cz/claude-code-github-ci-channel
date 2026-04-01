import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isActionable, parseWorkflowEvent, verifySignature } from "../server.js";
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

  it("returns false for unknown event", () => {
    expect(isActionable("push", { action: "completed" })).toBe(false);
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
