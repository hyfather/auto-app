import { prisma } from "@/lib/db";
import { getActiveCycle } from "./cycle";

export async function getActiveMission() {
  return prisma.mission.findFirst({ where: { status: "active" }, orderBy: { updatedAt: "desc" } });
}

export async function setActiveMission(text: string) {
  const missionText = text.trim();
  if (!missionText) throw new Error("Mission text is required.");
  await prisma.mission.updateMany({ where: { status: "active" }, data: { status: "archived" } });
  return prisma.mission.create({
    data: {
      title: missionText,
      description: missionText,
      successCriteria: "AutoApp should repeatedly run an OODA loop from Slack, improve the public Vercel app through small Codex PRs, and autonomously merge safe core changes that satisfy acceptance criteria.",
      status: "active",
    },
  });
}

export async function incorporateMissionInput(text: string) {
  const input = text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
  if (!input) throw new Error("Mission input is required.");

  const active = await getActiveMission();
  if (!active) return setActiveMission(input);

  const timestamp = new Date().toISOString();
  const addition = `[${timestamp}] Slack guidance: ${input}`;
  const description = active.description.includes(addition) ? active.description : `${active.description}\n\n${addition}`;

  return prisma.mission.update({
    where: { id: active.id },
    data: {
      description,
      successCriteria: "AutoApp should satisfy the active mission plus every Slack guidance note in the mission description, keep the interaction conversational, and keep improving through autonomous OODA cycles.",
    },
  });
}

export async function pauseMission() {
  const activeCycle = await getActiveCycle();
  if (activeCycle) {
    await prisma.decision.create({
      data: {
        cycleId: activeCycle.id,
        decision: "paused",
        decidedBySlackUserId: "autoapp",
        rationale: "Mission was paused from Slack; AutoApp should not advance this cycle until resumed.",
      },
    });
  }
  return prisma.mission.updateMany({ where: { status: "active" }, data: { status: "paused" } });
}

export async function resumeLatestMission() {
  const mission = await prisma.mission.findFirst({ where: { status: "paused" }, orderBy: { updatedAt: "desc" } });
  if (!mission) return null;
  await prisma.mission.updateMany({ where: { status: "active" }, data: { status: "archived" } });
  return prisma.mission.update({ where: { id: mission.id }, data: { status: "active" } });
}

export async function abortActiveMission(userId = "autoapp", slackMessageTs?: string) {
  const mission = await getActiveMission();
  const activeCycles = await prisma.cycle.findMany({
    where: {
      status: {
        in: [
          "observing",
          "proposed",
          "approved",
          "running",
          "waiting_for_codex",
          "pr_opened",
          "waiting_for_checks",
          "waiting_for_preview_deploy",
          "preview_deployed",
          "waiting_for_merge",
          "waiting_for_production_deploy",
          "production_deployed",
        ],
      },
    },
  });

  await prisma.$transaction([
    ...activeCycles.map((cycle) => prisma.decision.create({
      data: {
        cycleId: cycle.id,
        decision: "rejected",
        decidedBySlackUserId: userId,
        slackMessageTs,
        rationale: "Human aborted the mission from Slack and requested a fresh start.",
      },
    })),
    ...activeCycles.map((cycle) => prisma.cycle.update({
      where: { id: cycle.id },
      data: { status: "rejected", resultSummary: "Aborted from Slack so AutoApp can start fresh." },
    })),
    ...(mission ? [prisma.mission.update({ where: { id: mission.id }, data: { status: "archived" } })] : []),
  ]);

  return { mission, abortedCycles: activeCycles.length };
}
