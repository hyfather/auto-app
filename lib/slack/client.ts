import { WebClient } from "@slack/web-api";

export function getSlackClient() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  return new WebClient(token);
}
