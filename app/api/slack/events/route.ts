import { NextResponse } from "next/server";
import { after } from "next/server";
import { handleChannelMessage, handleMention, handleReactionCommand, recordSlackMessage } from "@/lib/slack/handlers";
import { nudgeActiveTasks } from "@/lib/autoapp/execute";
import { isMessageTrackedByTask } from "@/lib/autoapp/task";
import { getBotUserId } from "@/lib/slack/client";
import { postToGeneral } from "@/lib/slack/postMessage";
import { markMessageDone, markMessageWorking } from "@/lib/slack/reactions";
import { hasAutoappRepliedInThread } from "@/lib/slack/threadHistory";
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
  // `reaction_added`/`reaction_removed` events describe the reacted-to message
  // under `item` (with its own `channel`) rather than at the top level.
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
};

/**
 * The channel an event belongs to. Message/app_mention events carry it at the
 * top level; reaction events carry it on `item.channel`. Normalizing here lets
 * the #general gate accept reactions too.
 */
function eventChannel(event: SlackEvent): string | undefined {
  return event.channel || event.item?.channel;
}

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

/**
 * Slack `message` subtypes we treat as real human messages worth answering.
 * Most subtypes (joins, edits, deletions, bot messages, …) are housekeeping we
 * skip. A plain message has no subtype; file shares and thread broadcasts carry
 * human text we still want to handle.
 */
const ANSWERABLE_SUBTYPES = new Set([undefined, "", "file_share", "thread_broadcast"]);

/**
 * A genuine human message from someone other than AutoApp itself. We never
 * respond to integration bots (Cursor/GitHub/Vercel posts carry `bot_id`) or to
 * our own messages, which prevents response loops now that AutoApp answers
 * every human message in the channel.
 */
function isHumanMessage(event: SlackEvent, botUserId?: string | null): boolean {
  if (event.type === "app_mention") return Boolean(event.user) && event.user !== botUserId;
  if (event.type && event.type !== "message") return false;
  if (event.bot_id || !event.user) return false;
  if (botUserId && event.user === botUserId) return false;
  return ANSWERABLE_SUBTYPES.has(event.subtype);
}

function isThreadReply(event: SlackEvent): boolean {
  return Boolean(event.thread_ts && event.thread_ts !== event.ts);
}

/**
 * Where AutoApp's reply (and any task progress it streams) should land. A
 * top-level `@autoapp` mention is answered inline in a thread hanging off the
 * user's own message (`event.ts`), so the response and any task updates stay
 * attached to the request the user can see. Mentions and conversational
 * messages that are already inside a thread keep replying in that thread.
 */
function replyThreadTs(event: SlackEvent) {
  return event.thread_ts || event.ts || undefined;
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

  if (!isHumanMessage(event, botUserId)) return;

  // AutoApp answers every human message in its channel, just like Cursor's
  // Slack integration: top-level messages and explicit @mentions always get a
  // reply, and a thread reply continues the conversation when AutoApp is
  // already part of that thread (or the reply reads conversational).
  const channelId = event.channel;
  const threadRoot = replyThreadTs(event);
  let shouldRespond = true;
  if (!mentions && isThreadReply(event)) {
    shouldRespond = (await hasAutoappRepliedInThread(channelId, event.thread_ts, botUserId)) || looksConversational(event);
  }
  if (!shouldRespond) return;

  const threadTs = threadRoot;
  // React to the user's own message with :eyes: so they get instant feedback
  // that AutoApp picked it up. A task launched from a top-level message owns the
  // same message (slackRootTs === event.ts) and will swap :eyes: for
  // :white_check_mark:/:warning:; anything else is finalized here.
  const reactionTs = event.ts;
  if (reactionTs) await markMessageWorking(reactionTs);

  const options = { threadTs, sourceTs: event.ts, channelId, botUserId };
  try {
    const response = mentions
      ? await handleMention(event.text || "", event.user || "unknown", options)
      : await handleChannelMessage(event.text || "", event.user || "unknown", options);
    await postToGeneral(response, threadTs);
    if (reactionTs && !(await isMessageTrackedByTask(reactionTs))) await markMessageDone(reactionTs, true);
  } catch (error) {
    console.error("[Slack events] Failed to handle message:", error instanceof Error ? error.message : error);
    await postToGeneral("I hit an unexpected error handling that. The team can check the logs; try `@autoapp status` or rephrase your request.", threadTs);
    if (reactionTs) await markMessageDone(reactionTs, false);
  }
}

/** A thread reply that reads like it's meant for AutoApp (a question or ask). */
function looksConversational(event: SlackEvent): boolean {
  return /\?|task|start|begin|kick off|launch|run|improve|make|change|remember|also|actually|instead|status|yes|no|sure|go ahead|sounds good/i.test(
    event.text || "",
  );
}

/**
 * A reaction added to a message in #general is treated as a manual "wake up"
 * nudge. On Vercel's free plan the scheduled cron (`/api/cron/poll`) only runs
 * once a day, so reacting to a message (e.g. one of AutoApp's status posts) lets
 * a user advance every in-flight task on demand. AutoApp's own lifecycle
 * reactions (:eyes:/:white_check_mark:/:warning:) are ignored so its reaction
 * changes can't trigger a self-perpetuating loop.
 */
async function processReactionEvent(event: SlackEvent): Promise<void> {
  const botUserId = await getBotUserId();
  if (botUserId && event.user === botUserId) return;
  // A cancel-style reacji (❌/🛑/🗑️ …) on a message tied to an active task
  // cancels it. Every reaction still nudges in-flight work forward.
  try {
    await handleReactionCommand(event.reaction || "", event.item?.ts, event.user || "unknown");
  } catch (error) {
    console.error("[Slack events] Failed to handle reaction command:", error instanceof Error ? error.message : error);
  }
  await nudgeActiveTasks();
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
  if (!event || eventChannel(event) !== process.env.SLACK_GENERAL_CHANNEL_ID || event.subtype === "bot_message_deleted") {
    return NextResponse.json({ ok: true });
  }

  // Process after responding so we always ack inside Slack's timeout window.
  // After handling the message, nudge any in-flight cycle forward so a launched
  // Cursor agent's PR gets discovered, watched, and merged even between cron runs.
  after(async () => {
    try {
      // A reaction carries no new content to record or reply to — it is purely a
      // manual wake-up signal that advances in-flight tasks (see above).
      if (event.type === "reaction_added") {
        await processReactionEvent(event);
        return;
      }
      await processEvent(event);
    } catch (error) {
      console.error("[Slack events] Unhandled processing error:", error instanceof Error ? error.message : error);
    }
    await nudgeActiveTasks();
  });

  return NextResponse.json({ ok: true });
}
