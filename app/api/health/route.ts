import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { countActiveTasks, MAX_ACTIVE_TASKS } from "@/lib/autoapp/task";
import { isMissingDatabaseSchemaError } from "@/lib/prisma-errors";
import { isCursorConfigured } from "@/lib/cursor/client";
import { isGitHubConfigured } from "@/lib/github/client";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "degraded" | "down";

/**
 * Lightweight health report for AutoApp. Returns a JSON summary of database
 * connectivity, configured integrations (booleans only — never secret values),
 * and the task queue capacity. Read-only: it only pings the database and counts
 * rows, so it is safe to poll from uptime monitors.
 *
 * Responds 200 when healthy, 503 when the database is unreachable or its schema
 * is missing so monitors treat the app as unhealthy.
 */
async function checkDatabase(): Promise<{ status: CheckStatus; activeTasks?: number; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const activeTasks = await countActiveTasks();
    return { status: "ok", activeTasks };
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return { status: "degraded", error: "schema_missing" };
    return { status: "down", error: "unreachable" };
  }
}

export async function GET() {
  const database = await checkDatabase();

  const integrations = {
    slack: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET),
    openai: Boolean(process.env.OPENAI_API_KEY),
    cursor: isCursorConfigured(),
    github: isGitHubConfigured(),
  };

  const healthy = database.status === "ok";

  const body = {
    status: healthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database: { status: database.status, ...(database.error ? { error: database.error } : {}) },
    },
    integrations,
    tasks:
      database.activeTasks === undefined
        ? undefined
        : { active: database.activeTasks, max: MAX_ACTIVE_TASKS, atCapacity: database.activeTasks >= MAX_ACTIVE_TASKS },
  };

  return NextResponse.json(body, { status: healthy ? 200 : 503 });
}
