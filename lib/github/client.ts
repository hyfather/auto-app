const GITHUB_API_BASE = process.env.GITHUB_API_BASE_URL?.replace(/\/$/, "") || "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20000;

export type GitHubRepository = {
  owner: string;
  repo: string;
};

export type GitHubPullRequest = {
  html_url: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  draft: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable: boolean | null;
  mergeable_state?: string;
  updated_at: string;
  created_at: string;
  user?: { login?: string };
  head: {
    ref: string;
    sha: string;
    repo?: {
      full_name?: string;
      owner?: { login?: string };
    } | null;
  };
  base: {
    ref: string;
  };
};

export type GitHubCheckRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null | string;
};

export type GitHubCombinedStatus = {
  state: "success" | "failure" | "error" | "pending";
  statuses: Array<{ context: string; state: "success" | "failure" | "error" | "pending" | string }>;
};

export type PullRequestChecks = {
  state: "success" | "pending" | "failure" | "none";
  total: number;
  failing: string[];
  pending: string[];
};

export type GitHubDeployment = {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  creator?: { login?: string } | null;
};

export type GitHubDeploymentStatus = {
  state: "error" | "failure" | "inactive" | "in_progress" | "queued" | "pending" | "success" | string;
  description?: string | null;
  environment?: string;
  target_url?: string | null;
  environment_url?: string | null;
  created_at: string;
  updated_at: string;
};

export class GitHubApiError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PAT?.trim() || undefined;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/, "");
}

export function parseGitHubRepository(value: string | undefined): GitHubRepository | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (ssh) return { owner: ssh[1], repo: stripGitSuffix(ssh[2]) };

  const shorthand = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: stripGitSuffix(shorthand[2]) };

  try {
    const url = new URL(raw);
    if (!/github\.com$/i.test(url.hostname)) return undefined;
    const [owner, repo] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !repo) return undefined;
    return { owner, repo: stripGitSuffix(repo) };
  } catch {
    return undefined;
  }
}

export function getGitHubRepository(): GitHubRepository | undefined {
  return parseGitHubRepository(process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || process.env.CURSOR_AGENT_REPO_URL);
}

export function isGitHubConfigured(): boolean {
  return Boolean(getToken() && getGitHubRepository());
}

export function parsePullRequestUrl(prUrl: string | undefined): (GitHubRepository & { number: number }) | undefined {
  const raw = prUrl?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!/github\.com$/i.test(url.hostname)) return undefined;
    const [owner, repo, pull, number] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !repo || pull !== "pull" || !number) return undefined;
    const parsed = Number.parseInt(number, 10);
    if (!Number.isFinite(parsed)) return undefined;
    return { owner, repo, number: parsed };
  } catch {
    return undefined;
  }
}

function requireConfig(): { token: string; repository: GitHubRepository } {
  const token = getToken();
  const repository = getGitHubRepository();
  if (!token) throw new Error("GITHUB_TOKEN is required to watch and merge pull requests.");
  if (!repository) throw new Error("GITHUB_REPOSITORY or CURSOR_AGENT_REPO_URL is required to identify the GitHub repository.");
  return { token, repository };
}

async function githubFetch<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "autoapp",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(`GitHub API error ${response.status} on ${init.method || "GET"} ${path}`, response.status, text.slice(0, 2000));
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GitHubApiError(`GitHub API request timed out after ${DEFAULT_TIMEOUT_MS}ms on ${init.method || "GET"} ${path}`, 504, "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function repoPath(repository: GitHubRepository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function configuredMergeMethod(): "merge" | "squash" | "rebase" {
  const method = process.env.GITHUB_MERGE_METHOD?.trim();
  return method === "merge" || method === "rebase" ? method : "squash";
}

export async function getPullRequest(prUrl: string): Promise<GitHubPullRequest> {
  const { token, repository } = requireConfig();
  const parsed = parsePullRequestUrl(prUrl);
  const number = parsed?.number;
  if (!number) throw new Error(`Invalid GitHub pull request URL: ${prUrl}`);
  const repo = parsed?.owner && parsed.repo ? { owner: parsed.owner, repo: parsed.repo } : repository;
  return githubFetch<GitHubPullRequest>(token, `${repoPath(repo)}/pulls/${number}`);
}

export async function listPullRequests(options: { state?: "open" | "closed" | "all"; head?: string; perPage?: number } = {}): Promise<GitHubPullRequest[]> {
  const { token, repository } = requireConfig();
  const params = new URLSearchParams({
    state: options.state || "open",
    sort: "updated",
    direction: "desc",
    per_page: String(options.perPage || 20),
  });
  if (options.head) params.set("head", options.head);
  return githubFetch<GitHubPullRequest[]>(token, `${repoPath(repository)}/pulls?${params.toString()}`);
}

export async function getPullRequestChecks(sha: string): Promise<PullRequestChecks> {
  const { token, repository } = requireConfig();
  const [combinedStatus, checkRuns] = await Promise.all([
    githubFetch<GitHubCombinedStatus>(token, `${repoPath(repository)}/commits/${encodeURIComponent(sha)}/status`),
    githubFetch<{ check_runs: GitHubCheckRun[] }>(token, `${repoPath(repository)}/commits/${encodeURIComponent(sha)}/check-runs`),
  ]);

  const failing = [
    ...combinedStatus.statuses.filter((status) => status.state === "failure" || status.state === "error").map((status) => status.context),
    ...checkRuns.check_runs.filter((run) => run.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion)).map((run) => run.name),
  ];
  const pending = [
    ...combinedStatus.statuses.filter((status) => status.state === "pending").map((status) => status.context),
    ...checkRuns.check_runs.filter((run) => run.status !== "completed").map((run) => run.name),
  ];
  const total = combinedStatus.statuses.length + checkRuns.check_runs.length;

  if (failing.length) return { state: "failure", total, failing, pending };
  if (pending.length || combinedStatus.state === "pending") return { state: "pending", total, failing, pending };
  if (total === 0) return { state: "none", total, failing, pending };
  return { state: "success", total, failing, pending };
}

export async function listDeployments(options: { environment?: string; ref?: string; perPage?: number } = {}): Promise<GitHubDeployment[]> {
  const { token, repository } = requireConfig();
  const params = new URLSearchParams({ per_page: String(options.perPage || 10) });
  if (options.environment) params.set("environment", options.environment);
  if (options.ref) params.set("ref", options.ref);
  return githubFetch<GitHubDeployment[]>(token, `${repoPath(repository)}/deployments?${params.toString()}`);
}

export async function getLatestDeploymentStatus(deploymentId: number): Promise<GitHubDeploymentStatus | undefined> {
  const { token, repository } = requireConfig();
  const statuses = await githubFetch<GitHubDeploymentStatus[]>(token, `${repoPath(repository)}/deployments/${deploymentId}/statuses?per_page=1`);
  return statuses[0];
}

export async function mergePullRequest(pr: GitHubPullRequest): Promise<{ sha: string; merged: boolean; message: string }> {
  const { token, repository } = requireConfig();
  const parsed = parsePullRequestUrl(pr.html_url);
  const repo = parsed?.owner && parsed.repo ? { owner: parsed.owner, repo: parsed.repo } : repository;
  return githubFetch<{ sha: string; merged: boolean; message: string }>(token, `${repoPath(repo)}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: {
      merge_method: configuredMergeMethod(),
      sha: pr.head.sha,
      commit_title: pr.title,
    },
  });
}
