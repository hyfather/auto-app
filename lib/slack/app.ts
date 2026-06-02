export const slackAppConfig = {
  mode: "events-api",
  channelEnv: "SLACK_GENERAL_CHANNEL_ID",
  command: "/autoapp",
  mentionControls: ["@autoapp start [mission]", "@autoapp status", "@autoapp pause", "@autoapp resume", "@autoapp abort", "@autoapp summarize"],
  threading: "Mention responses and autonomous OODA progress are posted in the originating #general thread.",
  logging: "AutoApp records control actions and tool updates as IntegrationEvent rows and mirrors verbose progress logs to Slack threads.",
  note: "AutoApp uses Cursor Cloud Agents (via the Cursor API) as its implementation worker, and reads GitHub/Vercel status from their Slack notifications in #general.",
};
