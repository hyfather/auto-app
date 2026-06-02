import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { handleMention, recordSlackMessage } from "@/lib/slack/handlers";
import { postToGeneral } from "@/lib/slack/postMessage";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

async function verify(req: Request, rawBody: string) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";
  const digest = `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  if (!signature || digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!(await verify(req, rawBody))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const body = JSON.parse(rawBody);
  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });
  const event = body.event;
  if (!event || event.channel !== process.env.SLACK_GENERAL_CHANNEL_ID || event.subtype === "bot_message_deleted") return NextResponse.json({ ok: true });
  const mentions = event.text?.includes(process.env.AUTOAPP_BOT_USER_ID || "@autoapp") || /@autoapp/i.test(event.text || "");
  let classified;
  try {
    classified = await recordSlackMessage(event);
  } catch (error) {
    if (!isMissingDatabaseSchemaError(error)) throw error;
    if (mentions) await postToGeneral(`[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`, event.thread_ts || event.ts);
    return NextResponse.json({ ok: true, warning: "database_schema_missing" });
  }
  if (mentions && classified.authorType !== "autoapp") {
    const response = await handleMention(event.text || "", event.user || "unknown", event.ts);
    await postToGeneral(response, event.thread_ts || event.ts);
  }
  return NextResponse.json({ ok: true });
}
