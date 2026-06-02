import { prisma } from "@/lib/db";
import { postToGeneral } from "@/lib/slack/postMessage";
import { countActiveCycles, getActiveCycles } from "./cycle";
import { getActiveMission } from "./mission";
import { formatCycleCode, visibleLog } from "./policies";
import { proposeNextChange } from "./propose";
import { evaluateWebAppAgainstMission } from "./webAppEvaluator";

/**
 * Observe the app/mission and (when there is queue capacity) propose the next
 * cycle. `maxActiveCycles` controls how many in-flight cycles are tolerated
 * before this returns `queue_full`. Deliberate user `start`/`propose` requests
 * pass the full queue cap so several features can run in parallel; the
 * autonomous observe cron defaults to 1 so it does not flood the queue with
 * generated proposals on top of human-requested work.
 */
export async function runObservationCycle({ post = true, threadTs, maxActiveCycles = 1 }: { post?: boolean; threadTs?: string; maxActiveCycles?: number } = {}) {
  const mission = await getActiveMission();
  if (post && threadTs) await postToGeneral("[AutoApp] Observing the current app and mission context now...", threadTs);
  if (!mission) return { status: "no_mission" as const };
  if (mission.status === "paused") return { status: "paused" as const };
  const activeCount = await countActiveCycles();
  if (activeCount >= Math.max(1, maxActiveCycles)) {
    return { status: "queue_full" as const, cycles: await getActiveCycles(), max: Math.max(1, maxActiveCycles) };
  }

  if (post && threadTs) await postToGeneral("[AutoApp] Loading recent high-signal Slack context for this decision...", threadTs);
  const recentMemory = await prisma.slackMemory.findMany({ where: { importance: { gte: 3 } }, orderBy: { createdAt: "desc" }, take: 20 });
  const evaluation = await evaluateWebAppAgainstMission(mission);
  if (post && threadTs) await postToGeneral(`[AutoApp] Evaluation complete: ${evaluation.alignmentScore ?? "unknown"}/100 — ${evaluation.evaluationSummary}`, threadTs);
  const proposal = proposeNextChange(mission, evaluation);
  if (post && threadTs) await postToGeneral(`[AutoApp] Oriented around the mission and selected a small ${proposal.riskLevel}-risk change. Creating the OODA cycle record...`, threadTs);
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
    const result = await postToGeneral(message, threadTs);
    await prisma.cycle.update({ where: { id: cycle.id }, data: { slackRootTs: threadTs || result.ts as string | undefined } });
  }
  return { status: "proposed" as const, cycle, evaluation, proposal };
}
