import { WebClient, LogLevel, retryPolicies } from "@slack/web-api";

let cachedClient: WebClient | null | undefined;

/**
 * Returns a configured Slack WebClient, or null when SLACK_BOT_TOKEN is unset
 * (local/dev). The client is configured with automatic retries and a request
 * timeout so transient Slack failures do not bubble up as unhandled errors.
 */
export function getSlackClient(): WebClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    cachedClient = null;
    return cachedClient;
  }
  cachedClient = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    timeout: 15000,
    logLevel: LogLevel.WARN,
  });
  return cachedClient;
}

let cachedBotUserId: string | null | undefined;

/**
 * Resolve AutoApp's own Slack user id. A real "@autoapp" mention is delivered
 * with the bot's user-id form (`<@U…>`) in the message text, so recognizing
 * mentions in plain `message` events requires knowing that id.
 *
 * Prefers the explicit `AUTOAPP_BOT_USER_ID` env var, then falls back to
 * `auth.test` so mentions work even when the var is left unset (the common
 * case). The looked-up id is cached; a transient lookup failure is not cached
 * so it can be retried on the next event.
 */
export async function getBotUserId(): Promise<string | null> {
  const configured = process.env.AUTOAPP_BOT_USER_ID?.trim();
  if (configured) return configured;
  if (cachedBotUserId !== undefined) return cachedBotUserId;

  const client = getSlackClient();
  // Without a bot token we cannot call auth.test, and that will not change
  // without a restart, so cache the negative result to avoid retry churn.
  if (!client) {
    cachedBotUserId = null;
    return cachedBotUserId;
  }
  try {
    const result = await client.auth.test();
    const id = (result.user_id as string | undefined)?.trim() || null;
    if (id) cachedBotUserId = id;
    return id;
  } catch (error) {
    console.error("[Slack] auth.test failed; cannot resolve bot user id:", error instanceof Error ? error.message : error);
    return null;
  }
}
