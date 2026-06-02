import {
  GitHubApiError,
  getLatestDeploymentStatus,
  getPullRequestChecks,
  isGitHubConfigured,
  listDeployments,
  listPullRequests,
  type GitHubPullRequest,
} from "./client";

const GITHUB_NOT_CONFIGURED = "GitHub is not configured. Set `GITHUB_TOKEN` plus `GITHUB_REPOSITORY` (or `CURSOR_AGENT_REPO_URL`) so I can read PRs and deployments.";

export type PullRequestState = "open" | "closed" | "all";

function describeError(error: unknown): string {
  if (error instanceof GitHubApiError) return `${error.message} (${error.body})`;
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Race a best-effort GitHub lookup against a deadline so a slow API call never
 * blows Slack's 3s slash-command budget. The underlying request keeps running;
 * we just stop waiting on it and show the fallback text instead.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number | undefined, fallback: T): Promise<T> {
  if (!ms) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  const suffix = diffMs >= 0 ? "ago" : "from now";
  if (seconds < 60) return `${seconds}s ${suffix}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

function pullRequestStateLabel(pr: GitHubPullRequest): string {
  if (pr.state === "closed") return pr.merged || pr.merged_at ? "merged" : "closed";
  return pr.draft ? "draft" : "open";
}

/**
 * Build a Slack-ready list of pull requests with their current state. When
 * `withChecks` is set we also fold in the combined GitHub check/status result
 * for each open PR (one extra round trip per PR, all fired in parallel).
 */
export async function summarizePullRequests(
  options: { state?: PullRequestState; withChecks?: boolean; limit?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!isGitHubConfigured()) return GITHUB_NOT_CONFIGURED;
  const state = options.state || "open";
  const limit = options.limit || 20;

  return withTimeout(buildPullRequestSummary(state, limit, options.withChecks), options.timeoutMs, "GitHub pull request lookup timed out. Try again in a moment.");
}

async function buildPullRequestSummary(state: PullRequestState, limit: number, withChecks?: boolean): Promise<string> {
  let prs: GitHubPullRequest[];
  try {
    prs = await listPullRequests({ state, perPage: limit });
  } catch (error) {
    return `Could not load pull requests from GitHub: ${describeError(error)}`;
  }
  if (!prs.length) return state === "open" ? "No open pull requests." : "No pull requests found.";

  const lines = await Promise.all(
    prs.slice(0, limit).map(async (pr) => {
      const flags = [pullRequestStateLabel(pr)];
      if (withChecks && pr.state === "open") {
        try {
          const checks = await getPullRequestChecks(pr.head.sha);
          if (checks.state !== "none") flags.push(`checks ${checks.state}`);
        } catch {
          flags.push("checks unknown");
        }
      }
      const title = pr.title.length > 80 ? `${pr.title.slice(0, 77)}...` : pr.title;
      const updated = formatRelativeTime(new Date(pr.updated_at));
      return `* #${pr.number} [${flags.join(" · ")}] ${title} — ${pr.html_url} (updated ${updated})`;
    }),
  );
  return lines.join("\n");
}

/**
 * Summarize the most recent GitHub deployment (Vercel publishes these through
 * its GitHub integration) and its latest status state, so AutoApp can answer
 * "when did we last deploy?" without calling the Vercel API.
 */
export async function summarizeLastDeployment(options: { environment?: string; timeoutMs?: number } = {}): Promise<string> {
  if (!isGitHubConfigured()) return GITHUB_NOT_CONFIGURED;
  return withTimeout(buildLastDeploymentSummary(options.environment), options.timeoutMs, "GitHub deployment lookup timed out. Try again in a moment.");
}

async function buildLastDeploymentSummary(environment?: string): Promise<string> {
  let deployments;
  try {
    deployments = await listDeployments({ environment, perPage: 1 });
  } catch (error) {
    return `Could not load deployments from GitHub: ${describeError(error)}`;
  }
  if (!deployments.length) return environment ? `No GitHub deployments found for environment "${environment}" yet.` : "No GitHub deployments recorded yet.";

  const deployment = deployments[0];
  let state = "state unknown";
  let url: string | undefined;
  try {
    const status = await getLatestDeploymentStatus(deployment.id);
    if (status) {
      state = status.state;
      url = status.environment_url || status.target_url || undefined;
    }
  } catch {
    // best-effort: keep the deployment timing even if status lookup fails
  }

  const when = new Date(deployment.created_at);
  const ref = deployment.ref ? ` of \`${deployment.ref}\`` : "";
  return `${deployment.environment} deployment${ref} is ${state} — ${formatRelativeTime(when)} (${when.toISOString()})${url ? ` — ${url}` : ""}`;
}
