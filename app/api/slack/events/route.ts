import { NextResponse } from "next/server";
import { after } from "next/server";
import { handleMention, recordSlackMessage } from "@/lib/slack/handlers";
import { nudgeActiveTasks } from "@/lib/autoapp/execute";
import { getBotUserId } from "@/lib/slack/client";
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

function mentionsAutoapp(event: SlackEvent, botUserId?: string | null) {
  // A real "@autoapp" mention is delivered as an `app_mention` event whose text
  // contains the bot's user-id form (`<@U…>`), not the literal "@autoapp". Trust
  // the event type so mentions work regardless of configuration; also match the
  // bot's resolved user id (or literal "@autoapp") so a mention that arrives only
  // as a plain `message` event is still recognized.
  if (event.type === "app_mention") return true;
  const text = event.text || "";
  return Boolean((botUserId && text.includes(botUserId)) || /@autoapp/i.test(text));
}

function shouldHandleConversationalReply(event: SlackEvent) {
  if (!event.thread_ts || event.bot_id || !event.user) return false;
  const text = event.text || "";
  return /\?|task|start|begin|kick off|launch|run|improve|make|change|remember|also|actually|instead|status/i.test(text);
}

/**
 * Where AutoApp's reply (and any task progress it streams) should land. A
 * brand-new top-level `@autoapp` mention is handled exactly like a `/autoapp`
 * slash command: AutoApp opens its own fresh thread in #general instead of
 * threading everything under the user's message, so a mention and a slash
 * command produce the same result. Mentions and conversational messages that
 * are already inside a thread keep replying in that thread.
 */
function replyThreadTs(event: SlackEvent) {
  return event.thread_ts || undefined;
}

async function processEvent(event: SlackEvent) {
  // Resolve the bot's own user id once so we can both recognize mentions that
  // arrive as plain `message` events and avoid responding to our own posts.
  const botUserId = await getBotUserId();
  const mentions = mentionsAutoapp(event, botUserId);
  let classified;
  try {
    classified = await recordSlackMessage(event, botUserId);
  } catch (error) {
    if (!isMissingDatabaseSchemaError(error)) {
      console.error("[Slack events] Failed to record message:", error instanceof Error ? error.message : error);
      return;
    }
    if (mentions) {
      await postToGeneral(`[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`, replyThreadTs(event));
    }
    return;
  }

  // A single user message can arrive as two events (e.g. an app_mention plus its
  // message.channels twin). The first one recorded handles it; the duplicate
  // bails so the user gets exactly one reply.
  if (classified.isDuplicate) return;

  const shouldRespond = mentions ? classified.authorType !== "autoapp" : shouldHandleConversationalReply(event) && classified.authorType === "human";
  if (!shouldRespond) return;

  const threadTs = replyThreadTs(event);
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
