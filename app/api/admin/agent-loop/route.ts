import { NextResponse } from "next/server";
import { runAgenticDiscovery } from "@/lib/auto-app/agents";
import { requireAdmin } from "@/lib/auto-app/auth";
import { recordAgentLoop } from "@/lib/auto-app/store";
import { agentLoopSchema, type UsageMetricSnapshot } from "@/lib/auto-app/types";

export async function POST(request: Request) {
  const admin = requireAdmin(request);
  if (admin instanceof Response) return admin;

  const payload = await request.json().catch(() => undefined);
  const parsed = agentLoopSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const metrics: UsageMetricSnapshot = {
    activeUsers: 0,
    conversionRate: 0,
    errorRate: 0,
    topRequests: ["Submit product ideas", "Generate pull-request plans", "Validate Vercel previews"],
    collectedAt: new Date().toISOString()
  };
  const result = await runAgenticDiscovery(parsed.data, metrics);
  recordAgentLoop(result.runIds, admin.actor, "Admin triggered agentic discovery from metrics and mission context.");

  return NextResponse.json({ result });
}
