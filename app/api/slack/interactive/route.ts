import { NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack/verify";

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifySlackRequest(req, rawBody)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  return NextResponse.json({ ok: true, message: "Interactive Slack actions are reserved for future extensions." });
}
