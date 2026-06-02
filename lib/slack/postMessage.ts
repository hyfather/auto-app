import { getSlackClient } from "./client";

const MAX_SLACK_TEXT = 3500;

/** Split long text into Slack-sized chunks, preferring line boundaries. */
function chunkText(text: string): string[] {
  if (text.length <= MAX_SLACK_TEXT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_SLACK_TEXT) {
    let cut = remaining.lastIndexOf("\n", MAX_SLACK_TEXT);
    if (cut <= 0) cut = MAX_SLACK_TEXT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

/**
 * Post a message to the configured #general channel. This function never
 * throws: Slack/network failures are logged and swallowed so a failed post can
 * never break a control-plane handler. Returns the timestamp of the first
 * posted chunk (used as a thread root), or undefined when nothing was posted.
 */
export async function postToGeneral(text: string, threadTs?: string): Promise<{ ts?: string }> {
  const channel = process.env.SLACK_GENERAL_CHANNEL_ID;
  const client = getSlackClient();
  const safeText = (text ?? "").toString().trim() || "(empty message)";

  if (!channel) {
    console.warn("[Slack] SLACK_GENERAL_CHANNEL_ID is not configured; message not sent.");
    return { ts: undefined };
  }
  if (!client) {
    console.log(`[Slack disabled] ${safeText}`);
    return { ts: undefined };
  }

  const chunks = chunkText(safeText);
  let firstTs: string | undefined;
  for (const chunk of chunks) {
    try {
      const result = await client.chat.postMessage({ channel, text: chunk, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
      if (!firstTs) firstTs = result.ts as string | undefined;
    } catch (error) {
      console.error("[Slack] Failed to post message:", error instanceof Error ? error.message : error);
      break;
    }
  }
  return { ts: firstTs };
}
