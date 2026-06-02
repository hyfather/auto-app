import { NextResponse } from "next/server";
import { autonomouslyApproveAndRequestAgent } from "@/lib/autoapp/execute";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

export async function POST() {
  try {
    const result = await runObservationCycle({ post: true });
    if (result.status === "proposed") await autonomouslyApproveAndRequestAgent(result.cycle.id);
    return NextResponse.json(result);
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return NextResponse.json({ status: "database_schema_missing", message: DATABASE_SCHEMA_SETUP_MESSAGE }, { status: 503 });
    throw error;
  }
}
