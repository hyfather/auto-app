import { prisma } from "@/lib/db";

/** A single turn of conversation fed back into the agent for context. */
export type ConversationTurn = { role: "user" | "assistant"; content: string };

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 1200;

/**
 * Reconstruct the conversation in a Slack thread so the agent can hold a
 * multi-turn dialogue (ask a clarifying question, then act on the answer).
 *
 * We read from `SlackMemory` — every message AutoApp sees in #general is
 * recorded there — so this needs no extra Slack API round trip and works the
 * same locally and in production. The current message (identified by
 * `excludeTs`) is left out because the caller passes it to the agent as the new
 * user turn. Operational bot chatter (Cursor/GitHub/Vercel notifications) is
 * dropped so the model focuses on the human↔AutoApp dialogue.
 *
 * @param threadRootTs The thread's root `ts` (a top-level message's own ts, or
 *   the `thread_ts` of a reply).
 */
export async function getThreadHistory(
  channelId: string | undefined,
  threadRootTs: string | undefined,
  botUserId: string | null | undefined,
  excludeTs?: string,
): Promise<ConversationTurn[]> {
  if (!channelId || !threadRootTs) return [];

  const rows = await prisma.slackMemory.findMany({
    where: {
      channelId,
      OR: [{ messageTs: threadRootTs }, { threadTs: threadRootTs }],
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    if (excludeTs && row.messageTs === excludeTs) continue;
    const isAutoapp = row.authorType === "autoapp" || (botUserId ? row.authorId === botUserId : false);
    // Skip third-party integration chatter so the dialogue stays human↔AutoApp.
    if (!isAutoapp && (row.authorType === "cursor" || row.authorType === "github" || row.authorType === "vercel")) continue;
    const content = (row.rawText || "").trim();
    if (!content) continue;
    turns.push({ role: isAutoapp ? "assistant" : "user", content: content.slice(0, MAX_TURN_CHARS) });
  }

  return turns.slice(-MAX_TURNS);
}

/**
 * Whether AutoApp has already spoken in this thread — i.e. the thread is an
 * ongoing AutoApp conversation. Used to decide whether a human's thread reply
 * (without an explicit @mention) should continue the dialogue.
 */
export async function hasAutoappRepliedInThread(
  channelId: string | undefined,
  threadRootTs: string | undefined,
  botUserId: string | null | undefined,
): Promise<boolean> {
  if (!channelId || !threadRootTs) return false;
  const authorClause = botUserId
    ? { OR: [{ authorType: "autoapp" as const }, { authorId: botUserId }] }
    : { authorType: "autoapp" as const };
  const row = await prisma.slackMemory.findFirst({
    where: {
      channelId,
      OR: [{ messageTs: threadRootTs }, { threadTs: threadRootTs }],
      ...authorClause,
    },
    select: { id: true },
  });
  return Boolean(row);
}
