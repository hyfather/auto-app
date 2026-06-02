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
