import { NextResponse } from "next/server";
import { after } from "next/server";
import { handleMention, recordSlackMessage } from "@/lib/slack/handlers";
import { nudgeActiveTasks } from "@/lib/autoapp/execute";
import { postToGeneral } from "@/lib/slack/postMessage";
import { verifySlackRequest } from "@/lib/slack/verify";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

type SlackEvent = {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
};

function mentionsAutoapp(text: string) {
  const botId = process.env.AUTOAPP_BOT_USER_ID;
  return Boolean((botId && text.includes(botId)) || /@autoapp/i.test(text));
}

function shouldHandleConversationalReply(event: SlackEvent) {
  if (!event.thread_ts || event.bot_id || !event.user) return false;
  const text = event.text || "";
  return /\?|task|start|begin|kick off|launch|run|improve|make|change|remember|also|actually|instead|status/i.test(text);
}

function shouldReplyInThread(text: string, mentions: boolean, threadTs?: string) {
  return mentions || Boolean(threadTs) || /(?:^|\s)status(?:\b|\?)/i.test(text);
}

async function processEvent(event: SlackEvent) {
  const mentions = mentionsAutoapp(event.text || "");
  let classified;
  try {
    classified = await recordSlackMessage(event);
  } catch (error) {
    if (!isMissingDatabaseSchemaError(error)) {
      console.error("[Slack events] Failed to record message:", error instanceof Error ? error.message : error);
      return;
    }
    if (mentions) {
      await postToGeneral(`[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`, shouldReplyInThread(event.text || "", mentions, event.thread_ts) ? event.thread_ts || event.ts : undefined);
    }
    return;
  }

  const shouldRespond = mentions ? classified.authorType !== "autoapp" : shouldHandleConversationalReply(event) && classified.authorType === "human";
  if (!shouldRespond) return;

  const threadTs = shouldReplyInThread(event.text || "", mentions, event.thread_ts) ? event.thread_ts || event.ts : undefined;
  try {
    const response = await handleMention(event.text || "", event.user || "unknown", { threadTs, sourceTs: event.ts });
    await postToGeneral(response, threadTs);
  } catch (error) {
    console.error("[Slack events] Failed to handle mention:", error instanceof Error ? error.message : error);
    await postToGeneral("I hit an unexpected error handling that. The team can check the logs; try `@autoapp status` or rephrase your request.", threadTs);
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifySlackRequest(req, rawBody)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let body: { type?: string; challenge?: string; event?: SlackEvent };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });

  // Slack retries a delivery if it does not receive a 2xx within ~3s. We
  // acknowledge immediately and process in the background, so a retry means the
  // original was already accepted — skip it to avoid duplicate responses.
  if (req.headers.get("x-slack-retry-num")) return NextResponse.json({ ok: true });

  const event = body.event;
  if (!event || event.channel !== process.env.SLACK_GENERAL_CHANNEL_ID || event.subtype === "bot_message_deleted") {
    return NextResponse.json({ ok: true });
  }

  // Process after responding so we always ack inside Slack's timeout window.
  // After handling the message, nudge any in-flight cycle forward so a launched
  // Cursor agent's PR gets discovered, watched, and merged even between cron runs.
  after(async () => {
    try {
      await processEvent(event);
    } catch (error) {
      console.error("[Slack events] Unhandled processing error:", error instanceof Error ? error.message : error);
    }
    await nudgeActiveTasks();
  });

  return NextResponse.json({ ok: true });
}
