import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { handleAutoappCommand } from "@/lib/slack/handlers";

async function verify(req: Request, rawBody: string) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
  if (!signature || digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!(await verify(req, rawBody))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const form = new URLSearchParams(rawBody);
  const text = form.get("text") || "help";
  const response = await handleAutoappCommand(text);
  return NextResponse.json({ response_type: "ephemeral", text: response });
}
