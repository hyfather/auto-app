import { getSlackClient } from "./client";

export async function postToGeneral(text: string, threadTs?: string) {
  const channel = process.env.SLACK_GENERAL_CHANNEL_ID;
  const client = getSlackClient();
  if (!channel) throw new Error("SLACK_GENERAL_CHANNEL_ID is not configured.");
  if (!client) {
    console.log(`[Slack disabled] ${text}`);
    return { ts: undefined };
  }
  return client.chat.postMessage({ channel, text, thread_ts: threadTs });
}
