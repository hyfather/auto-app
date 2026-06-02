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

function mentionsAutoapp(text: string) {
  const botId = process.env.AUTOAPP_BOT_USER_ID;
  return Boolean((botId && text.includes(botId)) || /@autoapp/i.test(text));
}

function shouldHandleConversationalReply(event: { text?: string; user?: string; bot_id?: string; thread_ts?: string }) {
  if (!event.thread_ts || event.bot_id || !event.user) return false;
  const text = event.text || "";
  return /\?|mission|start|begin|kick off|launch|run|improve|make|change|remember|also|actually|instead|status/i.test(text);
}

function shouldReplyInThread(text: string) {
  return /(?:^|\s)status(?:\b|\?)/i.test(text);
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!(await verify(req, rawBody))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const body = JSON.parse(rawBody);
  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });
  const event = body.event;
  if (!event || event.channel !== process.env.SLACK_GENERAL_CHANNEL_ID || event.subtype === "bot_message_deleted") return NextResponse.json({ ok: true });

  const mentions = mentionsAutoapp(event.text || "");
  let classified;
  try {
    classified = await recordSlackMessage(event);
  } catch (error) {
    if (!isMissingDatabaseSchemaError(error)) throw error;
    if (mentions) await postToGeneral(`[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`, shouldReplyInThread(event.text || "") ? event.thread_ts || event.ts : undefined);
    return NextResponse.json({ ok: true, warning: "database_schema_missing" });
  }

  const shouldRespond = mentions ? classified.authorType !== "autoapp" : shouldHandleConversationalReply(event) && classified.authorType === "human";
  if (shouldRespond) {
    const response = await handleMention(event.text || "", event.user || "unknown", event.ts);
    const threadTs = shouldReplyInThread(event.text || "") ? event.thread_ts || event.ts : undefined;
    await postToGeneral(response, threadTs);
  }
  return NextResponse.json({ ok: true });
}
