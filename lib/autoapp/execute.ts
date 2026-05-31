import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import { formatCycleCode, visibleLog } from "./policies";

export async function approveAndRequestCodex(cycleId: string, userId: string, slackMessageTs?: string) {
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId }, include: { mission: true } });
  if (!cycle) throw new Error("No cycle found to approve.");
  if (cycle.status !== "proposed") throw new Error("Only a proposed cycle can be approved.");

  await prisma.decision.create({ data: { cycleId, decision: "approved", decidedBySlackUserId: userId, slackMessageTs, rationale: "Human approved the proposed AutoApp cycle in Slack." } });
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

Acceptance criteria:
${cycle.acceptanceCriteria.split("\n").map((item) => `* ${item}`).join("\n")}`);
  const result = await postToGeneral(text, cycle.slackRootTs || undefined);
  await prisma.cycle.update({ where: { id: cycleId }, data: { status: "waiting_for_codex", codexRequestTs: result.ts as string | undefined } });
  await postToGeneral(visibleLog(code, "Waiting", "Waiting for Codex, GitHub, and Vercel updates in #general."), cycle.slackRootTs || undefined);
}

export async function rejectCycle(cycleId: string, userId: string, slackMessageTs?: string) {
  await prisma.decision.create({ data: { cycleId, decision: "rejected", decidedBySlackUserId: userId, slackMessageTs, rationale: "Human rejected the proposed AutoApp cycle in Slack." } });
  return prisma.cycle.update({ where: { id: cycleId }, data: { status: "rejected", resultSummary: "Rejected by human in Slack before Codex execution." } });
}
