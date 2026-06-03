import { NextResponse } from "next/server";
import { nudgeActiveTasks } from "@/lib/autoapp/execute";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

/**
 * Scheduled sweep that advances every in-flight task: poll Cursor runs for
 * newly opened PRs, reconcile/merge open PRs through GitHub, and complete tasks
 * whose PR already merged. There is no longer an autonomous observe/propose
 * step — AutoApp only acts on tasks a human requested through Slack.
 */
async function poll() {
  try {
    const result = await nudgeActiveTasks();
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return NextResponse.json({ status: "database_schema_missing", message: DATABASE_SCHEMA_SETUP_MESSAGE }, { status: 503 });
    throw error;
  }
}

export async function POST() { return poll(); }
export async function GET() { return poll(); }
