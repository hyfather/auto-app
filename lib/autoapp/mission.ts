import { prisma } from "@/lib/db";

/**
 * AutoApp's overarching, durable "mission": a standing objective the operator
 * wants every task to advance. Unlike a per-task request, the mission persists
 * across tasks and is folded into the prompt of every new Cursor cloud agent
 * launch alongside the specific request.
 *
 * It is stored durably as an `IntegrationEvent` (`source: autoapp`,
 * `eventType: mission_set`) so we keep a full history without a schema change —
 * the most recent event wins, and an empty value means "no mission".
 */
export const MISSION_EVENT_TYPE = "mission_set";

/** The current mission text, or null when none is set (or it was cleared). */
export async function getMission(): Promise<string | null> {
  const latest = await prisma.integrationEvent.findFirst({
    where: { source: "autoapp", eventType: MISSION_EVENT_TYPE },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return null;
  const payload = latest.payload as { mission?: unknown } | null;
  const mission = typeof payload?.mission === "string" ? payload.mission.trim() : "";
  return mission || null;
}

/** Persist a new mission. Pass an empty string to clear it. */
export async function setMission(mission: string, userId = "autoapp"): Promise<string | null> {
  const text = mission.trim();
  await prisma.integrationEvent.create({
    data: { source: "autoapp", eventType: MISSION_EVENT_TYPE, payload: { mission: text, userId } },
  });
  return text || null;
}

/** Clear the durable mission so new tasks stop carrying mission context. */
export async function clearMission(userId = "autoapp"): Promise<void> {
  await setMission("", userId);
}
