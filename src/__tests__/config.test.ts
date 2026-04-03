import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, interpolate, loadConfig } from "../config.js";

// ── interpolate ───────────────────────────────────────────────────────────────
describe("interpolate", () => {
  it("replaces known placeholders", () => {
    expect(interpolate("Hello {name}, you are in {repo}!", { name: "Alice", repo: "acme/x" })).toBe(
      "Hello Alice, you are in acme/x!",
    );
  });

  it("leaves unknown placeholders unchanged", () => {
    expect(interpolate("See {run_url} for details", {})).toBe("See {run_url} for details");
  });

  it("handles empty template", () => {
    expect(interpolate("", { x: "y" })).toBe("");
  });

  it("replaces multiple occurrences", () => {
    expect(interpolate("{a} and {a}", { a: "X" })).toBe("X and X");
  });
});

// ── DEFAULT_CONFIG ────────────────────────────────────────────────────────────
describe("DEFAULT_CONFIG", () => {
  it("has main and master in main_branches", () => {
    expect(DEFAULT_CONFIG.server.main_branches).toContain("main");
    expect(DEFAULT_CONFIG.server.main_branches).toContain("master");
  });

  it("has empty allowed_events and allowed_repos (process all)", () => {
    expect(DEFAULT_CONFIG.webhooks.allowed_events).toHaveLength(0);
    expect(DEFAULT_CONFIG.webhooks.allowed_repos).toHaveLength(0);
  });

  it("has pr-comment-response as default skill", () => {
    expect(DEFAULT_CONFIG.behavior.on_pr_review.skill).toBe("pr-comment-response");
  });

  it("has require_plan=true for pr_review", () => {
    expect(DEFAULT_CONFIG.behavior.on_pr_review.require_plan).toBe(true);
  });

  it("has non-empty instruction for every behavior hook", () => {
    const hooks = [
      DEFAULT_CONFIG.behavior.on_ci_failure_main,
      DEFAULT_CONFIG.behavior.on_ci_failure_branch,
      DEFAULT_CONFIG.behavior.on_pr_review,
      DEFAULT_CONFIG.behavior.on_merge_conflict,
      DEFAULT_CONFIG.behavior.on_branch_behind,
    ] as const;
    for (const hook of hooks) {
      expect(hook.instruction.length).toBeGreaterThan(0);
    }
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────
describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gh-ci-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  it("throws for a missing file", () => {
    expect(() => loadConfig("/does/not/exist.yaml")).toThrow("not found");
  });

  it("throws for a non-object YAML file", () => {
    const p = write("bad.yaml", "- item1\n- item2\n");
    expect(() => loadConfig(p)).toThrow("must be a YAML object");
  });

  it("returns DEFAULT_CONFIG when YAML is an empty object", () => {
    const p = write("empty.yaml", "{}\n");
    const cfg = loadConfig(p);
    expect(cfg.server.main_branches).toEqual(DEFAULT_CONFIG.server.main_branches);
    expect(cfg.behavior.on_pr_review.skill).toBe("pr-comment-response");
  });

  it("overrides server.debounce_ms", () => {
    const p = write("debounce.yaml", "server:\n  debounce_ms: 5000\n");
    const cfg = loadConfig(p);
    expect(cfg.server.debounce_ms).toBe(5000);
    // Other server fields keep defaults
    expect(cfg.server.cooldown_ms).toBe(DEFAULT_CONFIG.server.cooldown_ms);
  });

  it("overrides webhooks.allowed_repos", () => {
    const p = write("repos.yaml", "webhooks:\n  allowed_repos:\n    - myorg/frontend\n");
    const cfg = loadConfig(p);
    expect(cfg.webhooks.allowed_repos).toEqual(["myorg/frontend"]);
    expect(cfg.webhooks.allowed_events).toEqual([]);
  });

  it("overrides behavior.on_pr_review.skill", () => {
    const p = write("skill.yaml", "behavior:\n  on_pr_review:\n    skill: my-custom-skill\n");
    const cfg = loadConfig(p);
    expect(cfg.behavior.on_pr_review.skill).toBe("my-custom-skill");
    // Other behavior fields unchanged
    expect(cfg.behavior.on_pr_review.require_plan).toBe(true);
    expect(cfg.behavior.on_ci_failure_main.instruction).toBe(
      DEFAULT_CONFIG.behavior.on_ci_failure_main.instruction,
    );
  });

  it("overrides code_style", () => {
    const p = write("style.yaml", "code_style: Use tabs, not spaces.\n");
    const cfg = loadConfig(p);
    expect(cfg.code_style).toBe("Use tabs, not spaces.");
  });

  it("overrides main_branches", () => {
    const p = write("branches.yaml", "server:\n  main_branches:\n    - develop\n");
    const cfg = loadConfig(p);
    expect(cfg.server.main_branches).toEqual(["develop"]);
  });

  it("throws for a YAML file that parses to null", () => {
    const p = write("null.yaml", "null\n");
    expect(() => loadConfig(p)).toThrow("must be a YAML object");
  });

  it("throws for a YAML file that parses to a plain array", () => {
    const p = write("array.yaml", "- a\n- b\n");
    expect(() => loadConfig(p)).toThrow("must be a YAML object");
  });

  it("overrides nested instruction field", () => {
    const p = write(
      "instr.yaml",
      "behavior:\n  on_ci_failure_main:\n    instruction: custom instruction\n",
    );
    const cfg = loadConfig(p);
    expect(cfg.behavior.on_ci_failure_main.instruction).toBe("custom instruction");
    // Other behavior fields unchanged
    expect(cfg.behavior.on_pr_review.skill).toBe("pr-comment-response");
  });
});
