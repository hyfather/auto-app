import { NextResponse } from "next/server";
import { createImprovementPlan } from "@/lib/auto-app/harness";
import { ideaSchema } from "@/lib/auto-app/types";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => undefined);
  const parsed = ideaSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const plan = await createImprovementPlan(parsed.data);
  return NextResponse.json({ plan });
}
