import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import { getActiveCycle } from "./cycle";
import { getActiveMission } from "./mission";
import { formatCycleCode, visibleLog } from "./policies";
import { proposeNextChange } from "./propose";
import { evaluateWebAppAgainstMission } from "./webAppEvaluator";

export async function runObservationCycle({ post = true } = {}) {
  const mission = await getActiveMission();
  if (!mission) return { status: "no_mission" as const };
  if (mission.status === "paused") return { status: "paused" as const };
  const activeCycle = await getActiveCycle();
  if (activeCycle) return { status: "active_cycle_exists" as const, cycle: activeCycle };

  const recentMemory = await prisma.slackMemory.findMany({ where: { importance: { gte: 3 } }, orderBy: { createdAt: "desc" }, take: 20 });
  const evaluation = await evaluateWebAppAgainstMission(mission);
  const proposal = proposeNextChange(mission, evaluation);
  const cycle = await prisma.cycle.create({
    data: {
      missionId: mission.id,
      status: "proposed",
      observation: `${proposal.observation}\nRecent important Slack context: ${recentMemory.map((m) => m.normalizedText).slice(0, 3).join(" | ") || "none"}`,
      proposal: proposal.proposedChange,
      rationale: proposal.rationale,
      riskLevel: proposal.riskLevel,
      acceptanceCriteria: proposal.acceptanceCriteria.join("\n"),
      forbiddenAreas: proposal.forbiddenAreas.join("\n"),
    },
  });
  const code = formatCycleCode(cycle.id);
  const message = `${visibleLog(code, "Observation", proposal.observation)}\n\n${visibleLog(code, "Proposal", `${proposal.proposedChange}\nRisk: ${proposal.riskLevel}.\nScope: small public web app change.\nAcceptance criteria:\n${proposal.acceptanceCriteria.map((item) => `* ${item}`).join("\n")}\n\nDecision: AutoApp will proceed autonomously under the active mission unless paused or rejected.`)}`;
  if (post) {
    const result = await postToGeneral(message);
    await prisma.cycle.update({ where: { id: cycle.id }, data: { slackRootTs: result.ts as string | undefined } });
  }
  return { status: "proposed" as const, cycle, evaluation, proposal };
}
