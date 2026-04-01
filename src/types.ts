export interface CINotification {
  summary: string;
  meta: Record<string, string>;
}

export interface WorkflowRun {
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

export interface GitHubWebhookPayload {
  action?: string;
  repository?: { full_name: string };
  sender?: { login: string };
  workflow_run?: WorkflowRun;
  workflow_job?: WorkflowJob;
  check_suite?: CheckSuite;
  check_run?: CheckRun;
}
