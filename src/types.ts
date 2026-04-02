export interface CINotification {
  summary: string;
  meta: Record<string, string>;
}

export interface WorkflowRun {
  id?: number;
  name: string;
  conclusion: string | null;
  status: string;
  head_branch: string;
  run_number: number;
  html_url: string;
  run_started_at: string | null;
  updated_at: string | null;
  head_commit?: { message: string };
}

export interface WorkflowJob {
  name: string;
  conclusion: string | null;
  status: string;
  html_url: string;
  runner_name?: string;
  labels?: string[];
  steps?: Array<{ name: string; conclusion: string | null }>;
}

export interface CheckSuite {
  conclusion: string | null;
  app?: { name: string };
}

export interface CheckRun {
  name: string;
  conclusion: string | null;
  html_url: string;
  app?: { name: string };
}

/**
 * GitHub's computed merge status for a pull request.
 * GitHub sets this asynchronously — always check for "unknown" before acting.
 */
export type MergeableState =
  | "clean" // can merge without conflicts
  | "dirty" // merge conflicts exist
  | "behind" // branch is behind base, needs rebase (no conflicts)
  | "blocked" // branch protection rules not satisfied
  | "unstable" // CI failing but not a required check
  | "has_hooks" // webhooks are being processed
  | "unknown"; // GitHub is still computing — do not act yet

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  /** null while GitHub is computing mergeability */
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  user: { login: string };
}

export interface PRReview {
  id: number;
  user: { login: string };
  /** GitHub uses uppercase: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string | null;
  html_url: string;
  submitted_at: string | null;
}

export interface PRReviewComment {
  id: number;
  user: { login: string };
  body: string;
  html_url: string;
  /** File path the comment is anchored to */
  path: string;
  /** Null for outdated comments whose line no longer exists */
  line: number | null;
}

export interface IssueComment {
  id: number;
  user: { login: string };
  body: string;
  html_url: string;
}

/**
 * GitHub issue object as it appears in issue_comment payloads.
 * The `pull_request` field is present only when the issue is a PR.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: { url: string };
}

export interface PRReviewThread {
  /** Ordered oldest-first. Always has at least one entry. */
  comments: Array<{
    id: number;
    user: { login: string };
    body: string;
    html_url: string;
    path: string;
    line: number | null;
  }>;
}

export interface GitHubWebhookPayload {
  action?: string;
  number?: number;
  repository?: { full_name: string };
  sender?: { login: string };
  workflow_run?: WorkflowRun;
  workflow_job?: WorkflowJob;
  check_suite?: CheckSuite;
  check_run?: CheckRun;
  pull_request?: PullRequest;
  review?: PRReview;
  comment?: PRReviewComment | IssueComment;
  issue?: GitHubIssue;
  thread?: PRReviewThread;
}

export interface GitHubPushPayload {
  /** e.g. "refs/heads/main" */
  ref: string;
  repository: { full_name: string; default_branch: string };
  sender: { login: string };
}
