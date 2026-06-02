import { prisma } from "@/lib/db";
import { ACTIVE_CYCLE_STATUSES, formatCycleCode } from "./policies";

/**
 * Maximum number of OODA cycles AutoApp will keep in flight at once. New
 * feature requests queue behind in-flight work up to this cap instead of being
 * rejected because a single cycle is already active.
 */
export const MAX_ACTIVE_CYCLES = 5;

export async function getActiveCycle() {
  return prisma.cycle.findFirst({
    where: { status: { in: [...ACTIVE_CYCLE_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    include: { mission: true },
  });
}

/** All in-flight cycles, oldest first so the queue reads like a FIFO list. */
export async function getActiveCycles() {
  return prisma.cycle.findMany({
    where: { status: { in: [...ACTIVE_CYCLE_STATUSES] } },
    orderBy: { createdAt: "asc" },
    include: { mission: true },
  });
}

export async function countActiveCycles() {
  return prisma.cycle.count({ where: { status: { in: [...ACTIVE_CYCLE_STATUSES] } } });
}

/**
 * Resolve an active cycle from a user-supplied task code such as `AUTO-AB12CD`,
 * `ab12cd`, or `#3` (the 1-based slot in the queue). Returns null when nothing
 * matches so callers can give a friendly error instead of throwing.
 */
export async function findActiveCycleByReference(reference: string) {
  const cycles = await getActiveCycles();
  if (!cycles.length) return null;

  const trimmed = reference.trim();
  const slotMatch = trimmed.match(/^#?(\d{1,2})$/);
  if (slotMatch) {
    const index = Number(slotMatch[1]) - 1;
    return cycles[index] ?? null;
  }

  const normalized = trimmed.toUpperCase().replace(/^AUTO-?/, "").replace(/[^A-Z0-9]/g, "");
  if (!normalized) return null;
  return (
    cycles.find((cycle) => formatCycleCode(cycle.id) === `AUTO-${normalized}`) ??
    cycles.find((cycle) => cycle.id.slice(-6).toUpperCase() === normalized) ??
    cycles.find((cycle) => cycle.id.toUpperCase().endsWith(normalized)) ??
    null
  );
}

export async function getLatestCycle() {
  return prisma.cycle.findFirst({ orderBy: { updatedAt: "desc" }, include: { mission: true, memories: { orderBy: { createdAt: "desc" }, take: 20 } } });
}
