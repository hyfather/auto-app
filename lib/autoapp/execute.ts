import type { Cycle, Mission, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import {
  CursorApiError,
  createCloudAgent,
  extractPrUrl,
  getAgent,
  getRun,
  isCursorConfigured,
  isTerminalRunStatus,
} from "@/lib/cursor/client";
import {
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
import { formatCycleCode, visibleLog } from "./policies";

const AUTOAPP_ACTOR = "autoapp";
const ACTIVE_PR_STATUSES = ["waiting_for_agent", "pr_opened", "waiting_for_checks", "waiting_for_preview_deploy", "preview_deployed", "waiting_for_merge"] as const;

function buildImplementationPrompt(cycle: Cycle & { mission: Mission }, code: string): string {
  const constraints = cycle.forbiddenAreas
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `* Do not change ${item}`)
    .join("\n");
  const acceptance = cycle.acceptanceCriteria
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `* ${item}`)
    .join("\n");
  return `You are AutoApp's implementation worker, operating cycle ${code}.

Mission:
${cycle.mission.title}

Current web app evaluation summary:
${cycle.observation}

Task:
${cycle.proposal}

Constraints:
${constraints}
* Keep the diff small and focused
* Open a pull request against the default branch with a short, descriptive summary
* Do not modify auth, secrets, environment variables, billing, or deployment configuration

Acceptance criteria:
${acceptance}`;
}

/**
 * Approve a proposed cycle and dispatch the work to a Cursor cloud agent.
 * Designed to never throw on Slack/API failures — it records status and posts
 * a human-readable explanation instead, so the Slack control plane stays usable.
 */
export async function approveAndRequestAgent(cycleId: string, userId: string = AUTOAPP_ACTOR, slackMessageTs?: string): Promise<void> {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { mission: true } });
  if (!cycle) throw new Error("No cycle found to approve.");
  if (cycle.status !== "proposed") throw new Error("Only a proposed cycle can be approved.");

  await prisma.decision.create({
    data: {
      cycleId,
      decision: "approved",
      decidedBySlackUserId: userId,
      slackMessageTs,
      rationale: userId === AUTOAPP_ACTOR ? "AutoApp approved this OODA cycle autonomously under the active mission." : "Human approved the proposed AutoApp cycle in Slack.",
    },
  });
  await prisma.cycle.update({ where: { id: cycleId }, data: { status: "approved" } });

  const code = formatCycleCode(cycle.id);
  const threadTs = cycle.slackRootTs || undefined;

  if (!isCursorConfigured()) {
    await prisma.cycle.update({ where: { id: cycleId }, data: { status: "failed", resultSummary: "Cursor cloud agent is not configured (CURSOR_API_KEY / CURSOR_AGENT_REPO_URL)." } });
    await postToGeneral(visibleLog(code, "Waiting", "I approved this change but cannot dispatch it yet: set `CURSOR_API_KEY` and `CURSOR_AGENT_REPO_URL` so I can launch a Cursor cloud agent to implement it."), threadTs);
    return;
  }

  const prompt = buildImplementationPrompt(cycle, code);
  try {
    const { agent, run } = await createCloudAgent({ prompt, name: `${code}: ${cycle.mission.title}` });
    await prisma.cycle.update({
      where: { id: cycleId },
      data: { status: "waiting_for_agent", cursorAgentId: agent.id, cursorRunId: run.id, cursorAgentUrl: agent.url ?? null },
    });
    await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_launched", payload: { cycleId, agentId: agent.id, runId: run.id, url: agent.url ?? null }, relatedCycleId: cycleId } });
    await postToGeneral(visibleLog(code, "Action", `Launched a Cursor cloud agent to implement ${code}.${agent.url ? `\nAgent: ${agent.url}` : ""}`), threadTs);
    await postToGeneral(visibleLog(code, "Waiting", "The cloud agent is implementing the change and will open a PR. I will watch Cursor for the PR link, then watch and merge the PR through the GitHub API."), threadTs);
  } catch (error) {
    const detail = error instanceof CursorApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.cycle.update({ where: { id: cycleId }, data: { status: "failed", resultSummary: `Failed to launch Cursor cloud agent: ${detail}` } });
    await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_launch_failed", payload: { cycleId, detail }, relatedCycleId: cycleId } });
    await postToGeneral(visibleLog(code, "Result", `I could not launch the Cursor cloud agent for ${code}: ${detail}. Use \`@autoapp start\` to retry once the issue is resolved.`), threadTs);
  }
}

export async function autonomouslyApproveAndRequestAgent(cycleId: string): Promise<void> {
  return approveAndRequestAgent(cycleId, AUTOAPP_ACTOR);
}

/**
 * Poll a cycle's cloud agent run and reconcile cycle state. Returns true when
 * the run reached a terminal state. Safe to call repeatedly (idempotent).
 */
export async function pollCycleAgent(cycleId: string): Promise<boolean> {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId } });
  if (!cycle || !cycle.cursorAgentId || !cycle.cursorRunId) return false;
  if (cycle.status === "completed" || cycle.status === "failed" || cycle.status === "rejected") return true;
  if (!isCursorConfigured()) return false;

  const code = formatCycleCode(cycle.id);
  const threadTs = cycle.slackRootTs || undefined;
  let run;
  try {
    run = await getRun(cycle.cursorAgentId, cycle.cursorRunId);
  } catch (error) {
    if (error instanceof CursorApiError && error.status === 404) {
      await prisma.cycle.update({ where: { id: cycleId }, data: { status: "failed", resultSummary: "Cursor cloud agent run was not found." } });
      await postToGeneral(visibleLog(code, "Result", "The Cursor cloud agent run is no longer available. Start a new cycle with `@autoapp start`."), threadTs);
      return true;
    }
    return false;
  }

  let prUrl = extractPrUrl(run);
  let headBranch = extractHeadBranch(run);
  if (!prUrl) {
    try {
      const agent = await getAgent(cycle.cursorAgentId);
      prUrl = extractPrUrl(agent);
      headBranch ||= extractHeadBranch(agent);
    } catch {
      // best-effort enrichment only
    }
  }

  const data: Prisma.CycleUpdateInput = {};
  if (prUrl && prUrl !== cycle.githubPrUrl) {
    data.githubPrUrl = prUrl;
    if (cycle.status === "waiting_for_agent") data.status = "pr_opened";
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

  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
  await prisma.integrationEvent.create({ data: { source: "cursor", eventType: `run_${run.status.toLowerCase()}`, payload: { cycleId, runId: run.id, prUrl: prUrl ?? null }, relatedCycleId: cycleId } });

  if (prUrl || headBranch || cycle.githubPrUrl) await reconcileCyclePullRequest(cycleId, { prUrl, headBranch });
  return isTerminalRunStatus(run.status);
}

/** Poll every cycle that has an in-flight cloud agent. */
export async function pollActiveAgents(): Promise<number> {
  const cycles = await prisma.cycle.findMany({
    where: {
      cursorAgentId: { not: null },
      status: { in: [...ACTIVE_PR_STATUSES] },
    },
    select: { id: true },
  });
  for (const cycle of cycles) await pollCycleAgent(cycle.id);
  return cycles.length;
}

/** Poll every active cycle with a PR or discoverable Cursor branch through GitHub. */
export async function pollActivePullRequests(): Promise<number> {
  const cycles = await prisma.cycle.findMany({
    where: {
      status: { in: [...ACTIVE_PR_STATUSES] },
      OR: [{ githubPrUrl: { not: null } }, { cursorAgentId: { not: null } }],
    },
    select: { id: true },
  });
  for (const cycle of cycles) await reconcileCyclePullRequest(cycle.id);
  return cycles.length;
}

export async function requestAutonomousMergeIfReady(cycleId: string): Promise<boolean> {
  return reconcileCyclePullRequest(cycleId);
}

export async function reconcileCyclePullRequest(cycleId: string, options: { prUrl?: string; headBranch?: string } = {}): Promise<boolean> {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { decisions: true } });
  if (!cycle || cycle.status === "completed" || cycle.status === "failed" || cycle.status === "rejected") return false;
  const code = formatCycleCode(cycle.id);
  const threadTs = cycle.slackRootTs || undefined;

  if (!isGitHubConfigured()) {
    await postOnce(cycleId, "github_not_configured", code, "Waiting", "I found PR work to watch, but GitHub API access is not configured. Set `GITHUB_TOKEN` plus `GITHUB_REPOSITORY` (or keep `CURSOR_AGENT_REPO_URL`) so I can watch and merge PRs directly.", threadTs);
    return false;
  }

  let pr: GitHubPullRequest | undefined;
  try {
    pr = await findCyclePullRequest(cycle, options);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_watch_failed", payload: { cycleId, detail }, relatedCycleId: cycleId } });
    return false;
  }
  if (!pr) return false;

  const data: Prisma.CycleUpdateInput = {};
  if (pr.html_url !== cycle.githubPrUrl) {
    data.githubPrUrl = pr.html_url;
    if (cycle.status === "waiting_for_agent") data.status = "pr_opened";
    await postToGeneral(visibleLog(code, "Result", `Found the pull request through GitHub: ${pr.html_url}`), threadTs);
  }

  let checks: PullRequestChecks | undefined;
  try {
    if (pr.state === "open") checks = await getPullRequestChecks(pr.head.sha);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_checks_failed_to_load", payload: { cycleId, prUrl: pr.html_url, detail }, relatedCycleId: cycleId } });
    await postOnce(cycleId, "github_pr_checks_failed_to_load_notice", code, "Waiting", `I found ${pr.html_url}, but GitHub check status could not be loaded: ${detail}. I will keep polling.`, threadTs);
    return false;
  }
  await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_state_polled", payload: { cycleId, prUrl: pr.html_url, state: pr.state, merged: pr.merged ?? false, draft: pr.draft, mergeable: pr.mergeable, mergeableState: pr.mergeable_state, checks: checks ?? null }, relatedCycleId: cycleId } });

  if (pr.state === "closed") {
    if (pr.merged) {
      data.status = "waiting_for_production_deploy";
      data.resultSummary = `Pull request ${pr.html_url} is merged; waiting for production deployment.`;
      await postOnce(cycleId, "github_pr_merged_detected", code, "Result", `GitHub reports ${pr.html_url} is merged. I am watching for the production deployment now.`, threadTs);
    } else {
      data.status = "failed";
      data.resultSummary = `Pull request ${pr.html_url} was closed without being merged.`;
      await postOnce(cycleId, "github_pr_closed_unmerged", code, "Result", `GitHub reports ${pr.html_url} was closed without being merged. This cycle is stopped.`, threadTs);
    }
    await updateCycleIfNeeded(cycleId, data);
    return true;
  }

  const readiness = getReadiness(pr, checks);
  if (readiness.status) data.status = readiness.status;
  if (readiness.resultSummary) data.resultSummary = readiness.resultSummary;
  await updateCycleIfNeeded(cycleId, data);

  if (!readiness.readyToMerge) {
    if (readiness.waitingMessage) await postOnce(cycleId, readiness.eventType, code, "Waiting", readiness.waitingMessage, threadTs);
    return true;
  }

  const alreadyRecommended = cycle.decisions.some((decision) => decision.decision === "merge_recommended");
  if (!alreadyRecommended) {
    await prisma.decision.create({
      data: {
        cycleId,
        decision: "merge_recommended",
        decidedBySlackUserId: AUTOAPP_ACTOR,
        rationale: "AutoApp saw a mergeable PR with passing GitHub checks and is authorized to merge safe core changes without human approval.",
      },
    });
  }

  try {
    const result = await mergePullRequest(pr);
    await prisma.cycle.update({ where: { id: cycleId }, data: { status: "waiting_for_production_deploy", resultSummary: `Merged ${pr.html_url} via GitHub API at ${result.sha}; waiting for production deployment.` } });
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_merged_by_autoapp", payload: { cycleId, prUrl: pr.html_url, sha: result.sha, message: result.message }, relatedCycleId: cycleId } });
    await postToGeneral(visibleLog(code, "Action", `Merged ${pr.html_url} through the GitHub API. I will watch for the production Vercel deployment update.`), threadTs);
  } catch (error) {
    const detail = error instanceof GitHubApiError ? `${error.message} (${error.body})` : error instanceof Error ? error.message : "unknown error";
    await prisma.cycle.update({ where: { id: cycleId }, data: { status: "waiting_for_merge", resultSummary: `GitHub merge attempt failed: ${detail}` } });
    await prisma.integrationEvent.create({ data: { source: "github", eventType: "pr_merge_failed", payload: { cycleId, prUrl: pr.html_url, detail }, relatedCycleId: cycleId } });
    await postOnce(cycleId, "github_pr_merge_failed_notice", code, "Waiting", `GitHub says ${pr.html_url} is ready, but the merge API call failed: ${detail}. I will keep watching the PR for a retryable state.`, threadTs);
  }
  return true;
}

function extractHeadBranch(source: { git?: { branches?: Array<{ branch?: string; prUrl?: string }> } } | undefined): string | undefined {
  const branches = source?.git?.branches || [];
  return branches.find((branch) => branch.prUrl && branch.branch)?.branch || branches.find((branch) => branch.branch)?.branch;
}

async function findCyclePullRequest(cycle: Cycle, options: { prUrl?: string; headBranch?: string }): Promise<GitHubPullRequest | undefined> {
  for (const prUrl of [options.prUrl, cycle.githubPrUrl].filter(Boolean) as string[]) {
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

  const code = formatCycleCode(cycle.id).toLowerCase();
  const recentOpenPrs = await listPullRequests({ state: "open", perPage: 20 });
  const codeMatch = recentOpenPrs.find((pr) => [pr.title, pr.body || "", pr.head.ref].some((value) => value.toLowerCase().includes(code)));
  if (codeMatch) return codeMatch;

  const authorLogin = process.env.GITHUB_CURSOR_AUTHOR_LOGIN?.trim();
  const createdAfter = cycle.createdAt.getTime() - 5 * 60 * 1000;
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
    return { readyToMerge: false, status: "failed", resultSummary: `GitHub checks failed for ${pr.html_url}: ${failing}.`, eventType: "github_pr_checks_failed", waitingMessage: `GitHub checks failed for ${pr.html_url}: ${failing}. This cycle is stopped.` };
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

async function updateCycleIfNeeded(cycleId: string, data: Prisma.CycleUpdateInput): Promise<void> {
  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
}

async function postOnce(cycleId: string, eventType: string, code: string, label: string, body: string, threadTs?: string): Promise<void> {
  const existing = await prisma.integrationEvent.findFirst({ where: { relatedCycleId: cycleId, eventType } });
  if (existing) return;
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType, payload: { cycleId, body }, relatedCycleId: cycleId } });
  await postToGeneral(visibleLog(code, label, body), threadTs);
}

export async function completeCycle(cycleId: string, resultSummary: string) {
  const cycle = await prisma.cycle.update({ where: { id: cycleId }, data: { status: "completed", resultSummary }, include: { mission: true } });
  const code = formatCycleCode(cycle.id);
  await postToGeneral(visibleLog(code, "Result", `${resultSummary}\nMission remains active: ${cycle.mission.title}\nNext step: I can start another OODA cycle when asked or when the observe cron runs.`), cycle.slackRootTs || undefined);
  return cycle;
}

export async function rejectCycle(cycleId: string, userId: string, slackMessageTs?: string) {
  await prisma.decision.create({ data: { cycleId, decision: "rejected", decidedBySlackUserId: userId, slackMessageTs, rationale: "Human rejected the proposed AutoApp cycle in Slack." } });
  return prisma.cycle.update({ where: { id: cycleId }, data: { status: "rejected", resultSummary: "Rejected by human in Slack before cloud agent execution." } });
}
