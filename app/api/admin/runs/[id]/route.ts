import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auto-app/auth";
import { getRun } from "@/lib/auto-app/store";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = requireAdmin(request);
  if (admin instanceof Response) return admin;

  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({ run });
}
