import type { Cycle, Mission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import {
  CursorApiError,
  createCloudAgent,
  createFollowupRun,
  extractPrUrl,
  getAgent,
  getRun,
  isCursorConfigured,
  isTerminalRunStatus,
} from "@/lib/cursor/client";
import { formatCycleCode, visibleLog } from "./policies";

const AUTOAPP_ACTOR = "autoapp";

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
    const { agent, run } = await createCloudAgent({ prompt, name: `${code}: ${cycle.mission.title}`, autoCreatePR: true });
    await prisma.cycle.update({
      where: { id: cycleId },
      data: { status: "waiting_for_agent", cursorAgentId: agent.id, cursorRunId: run.id, cursorAgentUrl: agent.url ?? null },
    });
    await prisma.integrationEvent.create({ data: { source: "cursor", eventType: "agent_launched", payload: { cycleId, agentId: agent.id, runId: run.id, url: agent.url ?? null }, relatedCycleId: cycleId } });
    await postToGeneral(visibleLog(code, "Action", `Launched a Cursor cloud agent to implement ${code}.${agent.url ? `\nAgent: ${agent.url}` : ""}`), threadTs);
    await postToGeneral(visibleLog(code, "Waiting", "The cloud agent is implementing the change and will open a PR. I will watch its progress plus GitHub/Vercel updates, and request merge autonomously when it looks ready."), threadTs);
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
  if (!prUrl) {
    try {
      prUrl = extractPrUrl(await getAgent(cycle.cursorAgentId));
    } catch {
      // best-effort enrichment only
    }
  }

  const data: Record<string, unknown> = {};
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
    await postToGeneral(visibleLog(code, "Result", "The Cursor cloud agent finished implementing the change. Watching GitHub checks and Vercel preview before requesting merge."), threadTs);
  }

  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
  await prisma.integrationEvent.create({ data: { source: "cursor", eventType: `run_${run.status.toLowerCase()}`, payload: { cycleId, runId: run.id, prUrl: prUrl ?? null }, relatedCycleId: cycleId } });

  if (prUrl) await requestAutonomousMergeIfReady(cycleId);
  return isTerminalRunStatus(run.status);
}

/** Poll every cycle that has an in-flight cloud agent. */
export async function pollActiveAgents(): Promise<number> {
  const cycles = await prisma.cycle.findMany({
    where: {
      cursorAgentId: { not: null },
      status: { in: ["waiting_for_agent", "pr_opened", "waiting_for_checks", "waiting_for_preview_deploy", "preview_deployed", "waiting_for_merge"] },
    },
    select: { id: true },
  });
  for (const cycle of cycles) await pollCycleAgent(cycle.id);
  return cycles.length;
}

export async function requestAutonomousMergeIfReady(cycleId: string): Promise<boolean> {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { decisions: true } });
  if (!cycle || cycle.status === "waiting_for_merge" || cycle.status === "completed" || cycle.status === "failed" || cycle.status === "rejected") return false;
  if (!cycle.githubPrUrl || !cycle.vercelPreviewUrl) return false;
  const alreadyRequested = cycle.decisions.some((decision) => decision.decision === "merge_recommended");
  if (alreadyRequested) return false;

  await prisma.decision.create({
    data: {
      cycleId,
      decision: "merge_recommended",
      decidedBySlackUserId: AUTOAPP_ACTOR,
      rationale: "AutoApp saw a PR plus Vercel preview signal and is authorized to merge safe core changes without human approval.",
    },
  });
  await prisma.cycle.update({ where: { id: cycleId }, data: { status: "waiting_for_merge" } });

  const code = formatCycleCode(cycle.id);
  const threadTs = cycle.slackRootTs || undefined;

  if (cycle.cursorAgentId && isCursorConfigured()) {
    try {
      await createFollowupRun(
        cycle.cursorAgentId,
        `Checks are green and the Vercel preview is ready for ${cycle.githubPrUrl}. If the implementation still satisfies the acceptance criteria, merge this pull request into the default branch. If you cannot merge, reply explaining what is blocking the merge.`,
      );
      await postToGeneral(visibleLog(code, "Action", `Asked the Cursor cloud agent to merge ${cycle.githubPrUrl} now that checks and preview look ready.`), threadTs);
    } catch (error) {
      const detail = error instanceof CursorApiError ? error.message : error instanceof Error ? error.message : "unknown error";
      await postToGeneral(visibleLog(code, "Waiting", `Wanted to ask the cloud agent to merge ${cycle.githubPrUrl}, but the follow-up request failed (${detail}). The PR is ready for a human merge.`), threadTs);
    }
  } else {
    await postToGeneral(visibleLog(code, "Action", `${cycle.githubPrUrl} looks ready to merge (checks green, preview deployed). A human can merge it, or configure a Cursor cloud agent to merge automatically.`), threadTs);
  }
  await postToGeneral(visibleLog(code, "Waiting", "Merge requested. I will watch for GitHub merge and production Vercel deployment updates."), threadTs);
  return true;
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
