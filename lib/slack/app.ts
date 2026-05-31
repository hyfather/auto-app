export const slackAppConfig = {
  mode: "events-api",
  channelEnv: "SLACK_GENERAL_CHANNEL_ID",
  command: "/autoapp",
  note: "AutoApp uses Slack as the integration bus and does not call Codex, GitHub, or Vercel APIs in v1.",
};
