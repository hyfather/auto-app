import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import { formatCycleCode, visibleLog } from "./policies";

const AUTOAPP_ACTOR = "autoapp";

export async function approveAndRequestCodex(cycleId: string, userId: string = AUTOAPP_ACTOR, slackMessageTs?: string) {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { mission: true } });
  if (!cycle) throw new Error("No cycle found to approve.");
  if (cycle.status !== "proposed") throw new Error("Only a proposed cycle can be approved.");

  await prisma.decision.create({ data: { cycleId, decision: "approved", decidedBySlackUserId: userId, slackMessageTs, rationale: userId === AUTOAPP_ACTOR ? "AutoApp approved this OODA cycle autonomously under the active mission." : "Human approved the proposed AutoApp cycle in Slack." } });
  await prisma.cycle.update({ where: { id: cycleId }, data: { status: "approved" } });

  const code = formatCycleCode(cycle.id);
  const text = visibleLog(code, "Action", `@Codex please implement ${code}.

Mission:
${cycle.mission.title}

Current web app evaluation summary:
${cycle.observation}

Task:
${cycle.proposal}

Constraints:
${cycle.forbiddenAreas.split("\n").map((item) => `* Do not change ${item}`).join("\n")}
* Keep the diff small
* Open a PR against main
* Include a short PR summary
* AutoApp is authorized to approve and merge safe core changes for this mission without human approval

Acceptance criteria:
${cycle.acceptanceCriteria.split("\n").map((item) => `* ${item}`).join("\n")}`);
  const result = await postToGeneral(text, cycle.slackRootTs || undefined);
  await prisma.cycle.update({ where: { id: cycleId }, data: { status: "waiting_for_codex", codexRequestTs: result.ts as string | undefined } });
  await postToGeneral(visibleLog(code, "Waiting", "Staying plugged into this thread for Codex, GitHub, and Vercel updates. I will autonomously request merge when the PR and preview look ready."), cycle.slackRootTs || undefined);
}

export async function autonomouslyApproveAndRequestCodex(cycleId: string) {
  return approveAndRequestCodex(cycleId, AUTOAPP_ACTOR);
}

export async function requestAutonomousMergeIfReady(cycleId: string) {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { decisions: true } });
  if (!cycle || cycle.status === "waiting_for_merge" || cycle.status === "completed" || cycle.status === "failed") return false;
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
  await postToGeneral(visibleLog(code, "Action", `@Codex please approve and merge this PR when checks are green and the implementation satisfies the acceptance criteria: ${cycle.githubPrUrl}`), cycle.slackRootTs || undefined);
  await postToGeneral(visibleLog(code, "Waiting", "Merge requested autonomously. I will watch for GitHub merge and production Vercel deployment updates."), cycle.slackRootTs || undefined);
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
  return prisma.cycle.update({ where: { id: cycleId }, data: { status: "rejected", resultSummary: "Rejected by human in Slack before Codex execution." } });
}
