import { prisma } from "@/lib/db";
import { ACTIVE_TASK_STATUSES, formatTaskCode } from "./policies";

/**
 * Maximum number of tasks AutoApp runs in parallel. When this many tasks are
 * already in flight, new requests are turned away (not queued) until a slot
 * frees up.
 */
export const MAX_ACTIVE_TASKS = 5;

export async function getActiveTask() {
  return prisma.task.findFirst({
    where: { status: { in: [...ACTIVE_TASK_STATUSES] } },
    orderBy: { updatedAt: "desc" },
  });
}

/** All in-flight tasks, oldest first so the list reads like a FIFO queue. */
export async function getActiveTasks() {
  return prisma.task.findMany({
    where: { status: { in: [...ACTIVE_TASK_STATUSES] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function countActiveTasks() {
  return prisma.task.count({ where: { status: { in: [...ACTIVE_TASK_STATUSES] } } });
}

/**
 * Resolve an active task from a user-supplied code such as `AUTO-AB12CD`,
 * `ab12cd`, or `#3` (the 1-based slot in the list). Returns null when nothing
 * matches so callers can give a friendly error instead of throwing.
 */
export async function findActiveTaskByReference(reference: string) {
  const tasks = await getActiveTasks();
  if (!tasks.length) return null;

  const trimmed = reference.trim();
  const slotMatch = trimmed.match(/^#?(\d{1,2})$/);
  if (slotMatch) {
    const index = Number(slotMatch[1]) - 1;
    return tasks[index] ?? null;
  }

  const normalized = trimmed.toUpperCase().replace(/^AUTO-?/, "").replace(/[^A-Z0-9]/g, "");
  if (!normalized) return null;
  return (
    tasks.find((task) => formatTaskCode(task.id) === `AUTO-${normalized}`) ??
    tasks.find((task) => task.id.slice(-6).toUpperCase() === normalized) ??
    tasks.find((task) => task.id.toUpperCase().endsWith(normalized)) ??
    null
  );
}

/**
 * Whether any task is anchored to this Slack message (its `slackRootTs`). When
 * true, the task lifecycle owns that message's reaction (it swaps :eyes: for
 * :white_check_mark:/:warning: as the work progresses), so a mention handler
 * should not finalize the reaction itself.
 */
export async function isMessageTrackedByTask(slackRootTs: string): Promise<boolean> {
  const task = await prisma.task.findFirst({ where: { slackRootTs }, select: { id: true } });
  return Boolean(task);
}

export async function getLatestTask() {
  return prisma.task.findFirst({ orderBy: { updatedAt: "desc" }, include: { memories: { orderBy: { createdAt: "desc" }, take: 20 } } });
}
