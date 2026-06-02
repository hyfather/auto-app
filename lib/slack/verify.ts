import crypto from "node:crypto";

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verify a Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * Returns true when the request is authentic. When SLACK_SIGNING_SECRET is not
 * set we return true so local development without secrets still works; in
 * production the secret should always be configured.
 *
 * Includes replay protection: requests whose timestamp is more than five
 * minutes from now are rejected even if the signature would otherwise match.
 */
export function verifySlackRequest(req: Request, rawBody: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;

  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const signature = req.headers.get("x-slack-signature") || "";
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false;

  const digest = `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const expected = Buffer.from(digest);
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}
