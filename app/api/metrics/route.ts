import { NextResponse } from "next/server";
import type { UsageMetricSnapshot } from "@/lib/auto-app/types";

export async function GET() {
  const snapshot: UsageMetricSnapshot = {
    activeUsers: 0,
    conversionRate: 0,
    errorRate: 0,
    topRequests: ["Submit product ideas", "Generate pull-request plans", "Validate Vercel previews"],
    collectedAt: new Date().toISOString()
  };

  return NextResponse.json({ snapshot });
}
