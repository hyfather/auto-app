export const slackAppConfig = {
  mode: "events-api",
  channelEnv: "SLACK_GENERAL_CHANNEL_ID",
  command: "/autoapp",
  mentionControls: ["@autoapp <what to build>", "@autoapp queue", "@autoapp status", "@autoapp prs", "@autoapp deployments", "@autoapp cancel AUTO-XXXXXX", "@autoapp evaluate"],
  threading: "Mention responses and task progress are posted in the originating #general thread.",
  logging: "AutoApp records control actions and tool updates as IntegrationEvent rows and mirrors verbose progress logs to Slack threads.",
  note: "AutoApp's Slack backend is a tool-calling agent. It launches Cursor Cloud Agents (via the Cursor API) as its implementation worker and reads GitHub/Vercel status from their Slack notifications in #general.",
};
