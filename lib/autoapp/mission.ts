import { prisma } from "@/lib/db";

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
      successCriteria: "The public Vercel app increasingly aligns with this mission through small reviewed PRs.",
      status: "active",
    },
  });
}

export async function pauseMission() {
  return prisma.mission.updateMany({ where: { status: "active" }, data: { status: "paused" } });
}

export async function resumeLatestMission() {
  const mission = await prisma.mission.findFirst({ where: { status: "paused" }, orderBy: { updatedAt: "desc" } });
  if (!mission) return null;
  await prisma.mission.updateMany({ where: { status: "active" }, data: { status: "archived" } });
  return prisma.mission.update({ where: { id: mission.id }, data: { status: "active" } });
}
