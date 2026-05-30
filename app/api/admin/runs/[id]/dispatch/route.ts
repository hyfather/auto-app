import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auto-app/auth";
import { dispatchRun } from "@/lib/auto-app/store";
import { adminRunCommandSchema } from "@/lib/auto-app/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = requireAdmin(request);
  if (admin instanceof Response) return admin;

  const payload = await request.json().catch(() => undefined);
  const parsed = adminRunCommandSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  try {
    const { id } = await params;
    const run = dispatchRun(id, parsed.data.actor ?? admin.actor, parsed.data.reason);
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Dispatch failed." }, { status: 409 });
  }
}
