import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auto-app/auth";
import { createRun, listRuns } from "@/lib/auto-app/store";
import { ideaSchema } from "@/lib/auto-app/types";

export async function GET(request: Request) {
  const admin = requireAdmin(request);
  if (admin instanceof Response) return admin;

  return NextResponse.json({ runs: listRuns() });
}

export async function POST(request: Request) {
  const admin = requireAdmin(request);
  if (admin instanceof Response) return admin;

  const payload = await request.json().catch(() => undefined);
  const parsed = ideaSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const run = await createRun(parsed.data, admin.actor);
  return NextResponse.json({ run }, { status: 201 });
}
