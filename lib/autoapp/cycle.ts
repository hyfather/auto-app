import { prisma } from "@/lib/db";
import { ACTIVE_CYCLE_STATUSES } from "./policies";

export async function getActiveCycle() {
  return prisma.cycle.findFirst({
    where: { status: { in: [...ACTIVE_CYCLE_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    include: { mission: true },
  });
}

export async function getLatestCycle() {
  return prisma.cycle.findFirst({ orderBy: { updatedAt: "desc" }, include: { mission: true, memories: { orderBy: { createdAt: "desc" }, take: 20 } } });
}
