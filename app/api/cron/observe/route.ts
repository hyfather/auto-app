import { NextResponse } from "next/server";
import { autonomouslyApproveAndRequestAgent, completeMergedCycles, pollActiveAgents, pollActivePullRequests } from "@/lib/autoapp/execute";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

async function observe() {
  try {
    const polledAgents = await pollActiveAgents();
    const polledPullRequests = await pollActivePullRequests();
    const completedMerged = await completeMergedCycles();
    const result = await runObservationCycle({ post: true });
    if (result.status === "proposed") await autonomouslyApproveAndRequestAgent(result.cycle.id);
    return NextResponse.json({ ...result, polledAgents, polledPullRequests, completedMerged });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return NextResponse.json({ status: "database_schema_missing", message: DATABASE_SCHEMA_SETUP_MESSAGE }, { status: 503 });
    throw error;
  }
}

export async function POST() { return observe(); }
export async function GET() { return observe(); }
