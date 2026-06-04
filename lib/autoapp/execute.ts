import type { Task, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import { syncTaskReaction } from "@/lib/slack/reactions";
import {
  CursorApiError,
  createCloudAgent,
  createFollowupRun,
  deleteAgent,
  extractPrUrl,
  getAgent,
  getRun,
  isCursorConfigured,
  isTerminalRunStatus,
} from "@/lib/cursor/client";
import {
  configuredMergeMethod,
  GitHubApiError,
  getGitHubRepository,
  getPullRequest,
  getPullRequestChecks,
  isGitHubConfigured,
  listPullRequests,
  mergePullRequest,
  parsePullRequestUrl,
  type GitHubPullRequest,
  type PullRequestChecks,
} from "@/lib/github/client";
import { MAX_ACTIVE_TASKS } from "./task";
import { getMission } from "./mission";
import { ACTIVE_TASK_STATUSES, DEFAULT_DOS, DEFAULT_FORBIDDEN_AREAS, formatTaskCode, visibleLog } from "./policies";

const AUTOAPP_ACTOR = "autoapp";
const ACTIVE_PR_STATUSES = ["waiting_for_agent", "pr_opened", "waiting_for_checks", "waiting_for_preview_deploy", "preview_deployed", "waiting_for_merge"] as const;

/** Whether the cloud agent should turn on GitHub native auto-merge for its PR. */
export function autoMergeEnabled(): boolean {
  return process.env.GITHUB_PR_AUTO_MERGE !== "false";
}

/**
 * Instruction appended to the implementation prompt that asks the Cursor cloud
 * agent to enable GitHub's native auto-merge on the PR it opens, so the PR
 * merges itself once all required status checks pass. AutoApp still watches and
 * merges the PR through the GitHub API as a fallback, so this is best-effort.
 */
export function autoMergeInstruction(): string {
  if (!autoMergeEnabled()) return "";
  const method = configuredMergeMethod();
  return [
    "",
    "Enable auto-merge so the pull request merges automatically once all required GitHub checks pass:",
    `* After opening the PR, enable GitHub native auto-merge with the GitHub CLI: \`gh pr merge --auto --${method} <pr-url-or-number>\``,
    "* Do not merge the PR yourself and do not bypass checks — GitHub must merge it only after every required status check passes",
    "* If auto-merge cannot be enabled (e.g. the repository does not allow auto-merge or has no required checks), leave the PR open and note it in the PR description; AutoApp will still watch the checks and merge through the GitHub API",
  ].join("\n");
}

/**
 * Build the prompt sent to the Cursor cloud agent for a task: the task request
 * plus do/don't guardrails and acceptance criteria. When an overarching durable
 * mission is set, it is included up front so the agent advances the specific
 * task in service of that standing objective.
 */
function buildImplementationPrompt(task: Task, code: string, mission?: string | null): string {
  const donts = task.forbiddenAreas
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `* Don't change ${item}`)
    .join("\n");
  const dos = DEFAULT_DOS.map((item) => `* ${item}`).join("\n");
  const acceptance = task.acceptanceCriteria
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `* ${item}`)
    .join("\n");
  const missionText = mission?.trim();
  const missionSection = missionText
    ? `Mission (AutoApp's overarching, durable objective — keep this in mind for every change):
${missionText}

`
    : "";
  return `You are AutoApp's implementation worker for task ${code}.

${missionSection}Task:
${task.request}

Do:
${dos}

Don't:
${donts}
* Don't modify auth, secrets, environment variables, billing, or deployment configuration

Acceptance criteria:
${acceptance}
${autoMergeInstruction()}`;
}

/**
 * Create a new task and immediately dispatch it to a Cursor cloud agent.
 * AutoApp runs at most `MAX_ACTIVE_TASKS` in parallel; when that many tasks are
 * already in flight a new request is turned away (not queued).
 */
export async function createTask(request: string, userId: string = AUTOAPP_ACTOR, threadTs?: string): Promise<
  | { status: "started"; task: Task; activeCount: number }
  | { status: "turned_away"; tasks: Task[]; max: number }
> {
  const text = request.trim();
  if (!text) throw new Error("A task request is required.");

  const activeCount = await prisma.task.count({ where: { status: { in: [...ACTIVE_TASK_STATUSES] } } });
  if (activeCount >= MAX_ACTIVE_TASKS) {
    const tasks = await prisma.task.findMany({ where: { status: { in: [...ACTIVE_TASK_STATUSES] } }, orderBy: { createdAt: "asc" } });
    return { status: "turned_away", tasks, max: MAX_ACTIVE_TASKS };
  }

  const task = await prisma.task.create({
    data: {
      status: "queued",
      request: text,
      acceptanceCriteria: [
        `Implement the requested change: ${text}`,
        "Keep the diff small and focused",
        "Verify the changed behavior before opening or updating the PR",
      ].join("\n"),
      forbiddenAreas: DEFAULT_FORBIDDEN_AREAS.join("\n"),
      slackRootTs: threadTs,
    },
  });
  const code = formatTaskCode(task.id);
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType: "task_created", payload: { taskId: task.id, request: text, userId, threadTs }, relatedTaskId: task.id } });
  const message = await postToGeneral(visibleLog(code, "Action", `Queued a new task and launching a Cursor cloud agent to implement it.\nRequest: ${text}`), threadTs);
  if (!threadTs && message.ts) await prisma.task.update({ where: { id: task.id }, data: { slackRootTs: message.ts } });
  // Mark the originating Slack message with :eyes: so the requester can see the
  // task is in flight; later transitions swap this for :white_check_mark: or :warning:.
  await syncTaskReaction(threadTs || message.ts, "queued");
  await launchTaskAgent(task.id);
  return { status: "started", task, activeCount: activeCount + 1 };
}

/**
 * Dispatch a queued task's work to a Cursor cloud agent. Designed to never throw
 * on Slack/API failures — it records status and posts a human-readable
 * explanation instead, so the Slack control plane stays usable.
 */
export async function launchTaskAgent(taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("No task found to launch.");

  const code = formatTaskCode(task.id);
  const threadTs = task.slackRootTs || undefined;

  if (!isCursorConfigured()) {
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed", resultSummary: "Cursor cloud agent is not configured (CURSOR_API_KEY / CURSOR_AGENT_REPO_URL)." } });
    await postToGeneral(visibleLog(code, "Waiting", "I queued this task but cannot dispatch it yet: set `CURSOR_API_KEY` and `CURSOR_AGENT_REPO_URL` so I can launch a Cursor cloud agent to implement it."), threadTs);
    await syncTaskReaction(threadTs, "failed");
    return;
  }

  const mission = await getMission();
  const prompt = buildImplementationPrompt(task, code, mission);
  try {
    const { agent, run } = await createCloudAgent({ prompt, name: `${code}: ${task.request.slice(0, 80)}` });
    await prisma.task.update({
      where: { id: taskId },
      data: { status: "waiting_for_agent", cursorAgentId: agent.id, cursorRunId: run.id, cursorAgentUrl: agent.url ?? null },
    });
    await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_launched", payload: { taskId, agentId: agent.id, runId: run.id, url: agent.url ?? null }, relatedTaskId: taskId } });
    await postToGeneral(visibleLog(code, "Action", `Launched a Cursor cloud agent to implement ${code}.${agent.url ? `\nAgent: ${agent.url}` : ""}`), threadTs);
    const mergePlan = autoMergeEnabled()
      ? "The cloud agent is implementing the change and will open a PR with GitHub auto-merge enabled, so it merges once all required checks pass. I will also watch the PR and merge it through the GitHub API as a fallback."
      : "The cloud agent is implementing the change and will open a PR. I will watch Cursor for the PR link, then watch and merge the PR through the GitHub API.";
    await postToGeneral(visibleLog(code, "Waiting", mergePlan), threadTs);
  } catch (error) {
    const detail = error instanceof CursorApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed", resultSummary: `Failed to launch Cursor cloud agent: ${detail}` } });
    await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_launch_failed", payload: { taskId, detail }, relatedTaskId: taskId } });
    await postToGeneral(visibleLog(code, "Result", `I could not launch the Cursor cloud agent for ${code}: ${detail}. Ask again once the issue is resolved.`), threadTs);
    await syncTaskReaction(threadTs, "failed");
  }
}

/**
 * Poll a task's cloud agent run and reconcile task state. Returns true when the
 * run reached a terminal state. Safe to call repeatedly (idempotent).
 */
export async function pollTaskAgent(taskId: string): Promise<boolean> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || !task.cursorAgentId || !task.cursorRunId) return false;
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return true;
  if (!isCursorConfigured()) return false;

  const code = formatTaskCode(task.id);
  const threadTs = task.slackRootTs || undefined;
  let run;
  try {
    run = await getRun(task.cursorAgentId, task.cursorRunId);
  } catch (error) {
    if (error instanceof CursorApiError && error.status === 404) {
      await prisma.task.update({ where: { id: taskId }, data: { status: "failed", resultSummary: "Cursor cloud agent run was not found." } });
      await postToGeneral(visibleLog(code, "Result", "The Cursor cloud agent run is no longer available. Ask AutoApp to start the task again."), threadTs);
      await syncTaskReaction(threadTs, "failed");
      return true;
    }
    return false;
  }

  let prUrl = extractPrUrl(run);
  let headBranch = extractHeadBranch(run);
  if (!prUrl) {
    try {
      const agent = await getAgent(task.cursorAgentId);
      prUrl = extractPrUrl(agent);
      headBranch ||= extractHeadBranch(agent);
    } catch {
      // best-effort enrichment only
    }
  }

  const data: Prisma.TaskUpdateInput = {};
  if (prUrl && prUrl !== task.githubPrUrl) {
    data.githubPrUrl = prUrl;
    if (task.status === "waiting_for_agent") data.status = "pr_opened";
    await postToGeneral(visibleLog(code, "Result", `The Cursor cloud agent opened a pull request: ${prUrl}`), threadTs);
  }

  if (run.status === "ERROR") {
    data.status = "failed";
    data.resultSummary = run.result || "Cursor cloud agent run ended with an error.";
    await postToGeneral(visibleLog(code, "Result", `The Cursor cloud agent run failed: ${run.result || "unknown error"}.`), threadTs);
  } else if (run.status === "CANCELLED" || run.status === "EXPIRED") {
    data.status = "failed";
    data.resultSummary = `Cursor cloud agent run ${run.status.toLowerCase()}.`;
    await postToGeneral(visibleLog(code, "Result", `The Cursor cloud agent run was ${run.status.toLowerCase()}.`), threadTs);
  } else if (run.status === "FINISHED" && prUrl) {
    await postToGeneral(visibleLog(code, "Result", "The Cursor cloud agent finished implementing the change. Watching GitHub PR checks and merge state now."), threadTs);
  }

  if (Object.keys(data).length) await prisma.task.update({ where: { id: taskId }, data });
  if (typeof data.status === "string") await syncTaskReaction(threadTs, data.status);
  await prisma.integrationEvent.create({ data: { source: "cursor", eventType: `run_${run.status.toLowerCase()}`, payload: { taskId, runId: run.id, prUrl: prUrl ?? null }, relatedTaskId: taskId } });

  if (prUrl || headBranch || task.githubPrUrl) await reconcileTaskPullRequest(taskId, { prUrl, headBranch });
  return isTerminalRunStatus(run.status);
}

/** Poll every task that has an in-flight cloud agent. */
export async function pollActiveAgents(): Promise<number> {
  const tasks = await prisma.task.findMany({
    where: {
      cursorAgentId: { not: null },
      status: { in: [...ACTIVE_PR_STATUSES] },
    },
    select: { id: true },
  });
  for (const task of tasks) await pollTaskAgent(task.id);
  return tasks.length;
}

/** Poll every active task with a PR or discoverable Cursor branch through GitHub. */
export async function pollActivePullRequests(): Promise<number> {
  const tasks = await prisma.task.findMany({
    where: {
      status: { in: [...ACTIVE_PR_STATUSES] },
      OR: [{ githubPrUrl: { not: null } }, { cursorAgentId: { not: null } }],
    },
    select: { id: true },
  });
  for (const task of tasks) await reconcileTaskPullRequest(task.id);
  return tasks.length;
}

export async function requestAutonomousMergeIfReady(taskId: string): Promise<boolean> {
  return reconcileTaskPullRequest(taskId);
}

/**
 * Statuses a task could be parked in after its PR merged but before this build
 * closed the loop directly on merge. A merged change on `main` is AutoApp's
 * success condition, so any task still sitting here is finished and should be
 * completed — without waiting for a Vercel production-deploy notification.
 */
const POST_MERGE_PENDING_STATUSES = ["waiting_for_production_deploy", "production_deployed"] as const;

/**
 * Complete any task whose PR already merged but that is lingering in a
 * post-merge "waiting for the production deployment" state. Closing the loop on
 * merge is the primary path; this sweep recovers tasks that entered the wait
 * state via a Slack-driven status update, so the loop never gets permanently
 * stuck once the code is live on main.
 */
export async function completeMergedTasks(): Promise<number> {
  const tasks = await prisma.task.findMany({
    where: { status: { in: [...POST_MERGE_PENDING_STATUSES] } },
    select: { id: true, githubPrUrl: true },
  });
  for (const task of tasks) {
    const prRef = task.githubPrUrl ? `Pull request ${task.githubPrUrl}` : "The pull request";
    await completeTask(task.id, `${prRef} is merged into main, so the change is live on the default branch. Marking this task successful.`);
  }
  return tasks.length;
}

/**
 * Best-effort, non-blocking advance of every in-flight task: poll Cursor runs
 * for newly opened PRs, then reconcile/merge open PRs through GitHub. This is
 * the same work the `/api/cron/poll` scheduler does, exposed so any Slack
 * interaction can also nudge the loop forward. That keeps a launched agent from
 * getting stuck in `waiting_for_agent` (with its PR never discovered or merged)
 * when the scheduled cron is delayed or not configured. Never throws.
 */
export async function nudgeActiveTasks(): Promise<{ polledAgents: number; polledPullRequests: number; completedMerged: number }> {
  try {
    const polledAgents = await pollActiveAgents();
    const polledPullRequests = await pollActivePullRequests();
    const completedMerged = await completeMergedTasks();
    return { polledAgents, polledPullRequests, completedMerged };
  } catch (error) {
    console.error("[AutoApp] Failed to advance active tasks:", error instanceof Error ? error.message : error);
    return { polledAgents: 0, polledPullRequests: 0, completedMerged: 0 };
  }
}

export async function reconcileTaskPullRequest(taskId: string, options: { prUrl?: string; headBranch?: string } = {}): Promise<boolean> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { decisions: true } });
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return false;
  const code = formatTaskCode(task.id);
  const threadTs = task.slackRootTs || undefined;

  if (!isGitHubConfigured()) {
    await postOnce(taskId, "github_not_configured", code, "Waiting", "I found PR work to watch, but GitHub API access is not configured. Set `GITHUB_TOKEN` plus `GITHUB_REPOSITORY` (or keep `CURSOR_AGENT_REPO_URL`) so I can watch and merge PRs directly.", threadTs);
    return false;
  }

  let pr: GitHubPullRequest | undefined;
  try {
    pr = await findTaskPullRequest(task, options);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_watch_failed", payload: { taskId, detail }, relatedTaskId: taskId } });
    return false;
  }
  if (!pr) return false;

  const data: Prisma.TaskUpdateInput = {};
  if (pr.html_url !== task.githubPrUrl) {
    data.githubPrUrl = pr.html_url;
    if (task.status === "waiting_for_agent") data.status = "pr_opened";
    await postToGeneral(visibleLog(code, "Result", `Found the pull request through GitHub: ${pr.html_url}`), threadTs);
  }

  let checks: PullRequestChecks | undefined;
  try {
    if (pr.state === "open") checks = await getPullRequestChecks(pr.head.sha);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_checks_failed_to_load", payload: { taskId, prUrl: pr.html_url, detail }, relatedTaskId: taskId } });
    await postOnce(taskId, "github_pr_checks_failed_to_load_notice", code, "Waiting", `I found ${pr.html_url}, but GitHub check status could not be loaded: ${detail}. I will keep polling.`, threadTs);
    return false;
  }
  await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_state_polled", payload: { taskId, prUrl: pr.html_url, state: pr.state, merged: pr.merged ?? false, draft: pr.draft, mergeable: pr.mergeable, mergeableState: pr.mergeable_state, checks: checks ?? null }, relatedTaskId: taskId } });

  if (pr.state === "closed") {
    if (pr.merged) {
      // A merged PR on the default branch is AutoApp's success condition. The
      // change is live on main, so we close the loop here instead of blocking
      // on a separate Vercel production-deploy signal that may never arrive.
      await updateTaskIfNeeded(taskId, data);
      await postOnce(taskId, "github_pr_merged_detected", code, "Result", `GitHub reports ${pr.html_url} is merged into main.`, threadTs);
      await completeTask(taskId, `Pull request ${pr.html_url} is merged into main, so the change is live on the default branch. Marking this task successful.`);
    } else {
      data.status = "failed";
      data.resultSummary = `Pull request ${pr.html_url} was closed without being merged.`;
      await postOnce(taskId, "github_pr_closed_unmerged", code, "Result", `GitHub reports ${pr.html_url} was closed without being merged. This task is stopped.`, threadTs);
      await updateTaskIfNeeded(taskId, data);
      await syncTaskReaction(threadTs, "failed");
    }
    return true;
  }

  const readiness = getReadiness(pr, checks);
  if (readiness.status) data.status = readiness.status;
  if (readiness.resultSummary) data.resultSummary = readiness.resultSummary;
  await updateTaskIfNeeded(taskId, data);
  if (readiness.status === "failed") await syncTaskReaction(threadTs, "failed");

  if (!readiness.readyToMerge) {
    if (readiness.waitingMessage) await postOnce(taskId, readiness.eventType, code, "Waiting", readiness.waitingMessage, threadTs);
    return true;
  }

  const alreadyRecommended = task.decisions.some((decision) => decision.decision === "merge_recommended");
  if (!alreadyRecommended) {
    await prisma.decision.create({
      data: {
        taskId,
        decision: "merge_recommended",
        decidedBySlackUserId: AUTOAPP_ACTOR,
        rationale: "AutoApp saw a mergeable PR with passing GitHub checks and is authorized to merge safe changes without human approval.",
      },
    });
  }

  try {
    const result = await mergePullRequest(pr);
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_merged_by_autoapp", payload: { taskId, prUrl: pr.html_url, sha: result.sha, message: result.message }, relatedTaskId: taskId } });
    await postToGeneral(visibleLog(code, "Action", `Merged ${pr.html_url} through the GitHub API at ${result.sha}.`), threadTs);
    // The merge landed on main, so the change is live on the default branch.
    // Close the loop now rather than waiting for a production-deploy signal.
    await completeTask(taskId, `Merged ${pr.html_url} into main via the GitHub API at ${result.sha}. The change is on the default branch, so this task is successful.`);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.task.update({ where: { id: taskId }, data: { status: "waiting_for_merge", resultSummary: `GitHub merge attempt failed: ${detail}` } });
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_merge_failed", payload: { taskId, prUrl: pr.html_url, detail }, relatedTaskId: taskId } });
    await postOnce(taskId, "github_pr_merge_failed_notice", code, "Waiting", `GitHub says ${pr.html_url} is ready, but the merge API call failed: ${detail}. I will keep watching the PR for a retryable state.`, threadTs);
  }
  return true;
}

function extractHeadBranch(source: { git?: { branches?: Array<{ branch?: string; prUrl?: string }> } } | undefined): string | undefined {
  const branches = source?.git?.branches || [];
  return branches.find((branch) => branch.prUrl && branch.branch)?.branch || branches.find((branch) => branch.branch)?.branch;
}

async function findTaskPullRequest(task: Task, options: { prUrl?: string; headBranch?: string }): Promise<GitHubPullRequest | undefined> {
  for (const prUrl of [options.prUrl, task.githubPrUrl].filter(Boolean) as string[]) {
    if (!parsePullRequestUrl(prUrl)) continue;
    try {
      return await getPullRequest(prUrl);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
  }

  const repository = getGitHubRepository();
  const headBranch = normalizeBranchName(options.headBranch);
  if (repository && headBranch) {
    const head = headBranch.includes(":") ? headBranch : `${repository.owner}:${headBranch}`;
    const [pr] = await listPullRequests({ state: "all", head, perPage: 5 });
    if (pr) return pr;
  }

  const code = formatTaskCode(task.id).toLowerCase();
  const recentOpenPrs = await listPullRequests({ state: "open", perPage: 20 });
  const codeMatch = recentOpenPrs.find((pr) => [pr.title, pr.body || "", pr.head.ref].some((value) => value.toLowerCase().includes(code)));
  if (codeMatch) return codeMatch;

  const authorLogin = process.env.GITHUB_CURSOR_AUTHOR_LOGIN?.trim();
  const createdAfter = task.createdAt.getTime() - 5 * 60 * 1000;
  const recentCandidates = recentOpenPrs.filter((pr) => {
    if (new Date(pr.created_at).getTime() < createdAfter) return false;
    return !authorLogin || pr.user?.login === authorLogin;
  });
  return recentCandidates.length === 1 ? recentCandidates[0] : undefined;
}

function normalizeBranchName(branch: string | undefined): string | undefined {
  return branch?.trim().replace(/^refs\/heads\//, "") || undefined;
}

function checksRequired(): boolean {
  return process.env.GITHUB_MERGE_REQUIRE_CHECKS !== "false";
}

function getReadiness(pr: GitHubPullRequest, checks: PullRequestChecks | undefined): {
  readyToMerge: boolean;
  status?: "pr_opened" | "waiting_for_checks" | "waiting_for_merge" | "failed";
  resultSummary?: string;
  eventType: string;
  waitingMessage?: string;
} {
  if (pr.base.ref !== "main") {
    return { readyToMerge: false, status: "failed", resultSummary: `Pull request ${pr.html_url} targets ${pr.base.ref}, not main.`, eventType: "github_pr_wrong_base", waitingMessage: `${pr.html_url} targets ${pr.base.ref}, so I will not merge it. Cursor PRs must target main.` };
  }

  if (pr.draft) {
    return { readyToMerge: false, status: "pr_opened", eventType: "github_pr_is_draft", waitingMessage: `${pr.html_url} is still a draft PR.` };
  }

  if (!checks) {
    return { readyToMerge: false, status: "waiting_for_checks", eventType: "github_pr_checks_missing", waitingMessage: `Waiting for GitHub checks on ${pr.html_url}.` };
  }

  if (checks.state === "failure") {
    const failing = checks.failing.join(", ") || "unknown failing check";
    return { readyToMerge: false, status: "failed", resultSummary: `GitHub checks failed for ${pr.html_url}: ${failing}.`, eventType: "github_pr_checks_failed", waitingMessage: `GitHub checks failed for ${pr.html_url}: ${failing}. This task is stopped.` };
  }

  if (checks.state === "pending") {
    return { readyToMerge: false, status: "waiting_for_checks", eventType: "github_pr_checks_pending", waitingMessage: `Waiting for GitHub checks on ${pr.html_url}: ${checks.pending.join(", ") || "pending checks"}.` };
  }

  if (checks.state === "none" && checksRequired()) {
    return { readyToMerge: false, status: "waiting_for_checks", eventType: "github_pr_checks_none", waitingMessage: `GitHub has not reported any checks for ${pr.html_url} yet.` };
  }

  if (pr.mergeable === false) {
    return { readyToMerge: false, status: "waiting_for_merge", resultSummary: `GitHub reports ${pr.html_url} is not mergeable (${pr.mergeable_state || "unknown"}).`, eventType: "github_pr_not_mergeable", waitingMessage: `GitHub reports ${pr.html_url} is not mergeable yet (${pr.mergeable_state || "unknown"}).` };
  }

  return { readyToMerge: true, status: "waiting_for_merge", eventType: "github_pr_ready_to_merge" };
}

async function updateTaskIfNeeded(taskId: string, data: Prisma.TaskUpdateInput): Promise<void> {
  if (Object.keys(data).length) await prisma.task.update({ where: { id: taskId }, data });
}

async function postOnce(taskId: string, eventType: string, code: string, label: string, body: string, threadTs?: string): Promise<void> {
  const existing = await prisma.integrationEvent.findFirst({ where: { relatedTaskId: taskId, eventType } });
  if (existing) return;
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType, payload: { taskId, body }, relatedTaskId: taskId } });
  await postToGeneral(visibleLog(code, label, body), threadTs);
}

export async function completeTask(taskId: string, resultSummary: string) {
  const task = await prisma.task.update({ where: { id: taskId }, data: { status: "completed", resultSummary } });
  const code = formatTaskCode(task.id);
  await postToGeneral(visibleLog(code, "Result", `${resultSummary}\nNext step: ask AutoApp for another change in Slack whenever you're ready.`), task.slackRootTs || undefined);
  await syncTaskReaction(task.slackRootTs, task.status);
  return task;
}

/**
 * Cancel a single queued/in-flight task. Marks the task cancelled, records the
 * decision, and makes a best-effort attempt to stop the backing Cursor cloud
 * agent so we stop paying for work that was discarded.
 */
export async function cancelTask(taskId: string, userId: string = AUTOAPP_ACTOR, slackMessageTs?: string): Promise<{ task: Task; agentStopped: boolean }> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("No task found to cancel.");
  const code = formatTaskCode(task.id);
  const threadTs = task.slackRootTs || undefined;

  let agentStopped = false;
  if (task.cursorAgentId && isCursorConfigured()) {
    try {
      await deleteAgent(task.cursorAgentId);
      agentStopped = true;
    } catch (error) {
      const detail = error instanceof CursorApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
      await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_cancel_failed", payload: { taskId, detail }, relatedTaskId: taskId } });
    }
  }

  await prisma.decision.create({ data: { taskId, decision: "cancelled", decidedBySlackUserId: userId, slackMessageTs, rationale: "Cancelled from Slack." } });
  const updated = await prisma.task.update({ where: { id: taskId }, data: { status: "cancelled", resultSummary: `Cancelled from Slack${agentStopped ? " (Cursor cloud agent stopped)" : ""}.` } });
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType: "task_cancelled", payload: { taskId, userId, agentStopped }, relatedTaskId: taskId } });
  await postToGeneral(visibleLog(code, "Action", `Cancelled this task at your request.${agentStopped ? " I asked Cursor to stop the cloud agent." : ""}`), threadTs);
  await syncTaskReaction(threadTs, updated.status);
  return { task: updated, agentStopped };
}

/**
 * Push updated instructions into an existing task. If the task has not launched
 * yet (`queued`) we rewrite its request/acceptance so the pending launch uses
 * the new text. If it already has a Cursor cloud agent, we send a follow-up run
 * so the live agent incorporates the guidance.
 */
export async function addGuidanceToTask(taskId: string, guidance: string, userId: string = AUTOAPP_ACTOR): Promise<{ task: Task; mode: "rewrote_request" | "followup_run" | "recorded" }> {
  const text = guidance.trim();
  if (!text) throw new Error("Updated instructions are required.");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("No task found to update.");
  const code = formatTaskCode(task.id);
  const threadTs = task.slackRootTs || undefined;

  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType: "task_update_requested", payload: { taskId, guidance: text, userId }, relatedTaskId: taskId } });

  if (task.status === "queued") {
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        request: text,
        acceptanceCriteria: [`Implement the updated request: ${text}`, "Keep the diff small and focused", "Verify the changed behavior before opening or updating the PR"].join("\n"),
      },
    });
    await postToGeneral(visibleLog(code, "Action", `Updated this task before launch.\nNew request: ${text}`), threadTs);
    return { task: updated, mode: "rewrote_request" };
  }

  if (task.cursorAgentId && isCursorConfigured()) {
    try {
      await createFollowupRun(task.cursorAgentId, `Updated instructions for ${code}: ${text}\n\nPlease incorporate this into the work in progress and update the pull request accordingly.`);
      await postToGeneral(visibleLog(code, "Action", `Sent your updated instructions to the running Cursor cloud agent.\nNew guidance: ${text}`), threadTs);
      return { task, mode: "followup_run" };
    } catch (error) {
      const detail = error instanceof CursorApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
      await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "task_followup_failed", payload: { taskId, detail }, relatedTaskId: taskId } });
    }
  }

  await postToGeneral(visibleLog(code, "Waiting", `Recorded your updated guidance for this task: ${text}`), threadTs);
  return { task, mode: "recorded" };
}
