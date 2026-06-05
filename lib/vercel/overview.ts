import { VercelApiError, isVercelConfigured, listVercelDeployments, type VercelDeployment } from "./client";

const VERCEL_NOT_CONFIGURED = "Vercel is not configured. Set `VERCEL_TOKEN` so I can read deployments and report operational health.";

function describeError(error: unknown): string {
  if (error instanceof VercelApiError) return `${error.message} (${error.body})`;
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Race a best-effort Vercel lookup against a deadline so a slow API call never
 * blows Slack's 3s slash-command budget. Mirrors the GitHub overview helper.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number | undefined, fallback: T): Promise<T> {
  if (!ms) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  const suffix = diffMs >= 0 ? "ago" : "from now";
  if (seconds < 60) return `${seconds}s ${suffix}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

function deploymentState(deployment: VercelDeployment): string {
  return (deployment.state || deployment.readyState || "UNKNOWN").toUpperCase();
}

/**
 * Build a Slack-ready summary of the latest Vercel deployments and their state
 * (READY / ERROR / BUILDING / …) so the agent can answer deployment and
 * operational-health questions without launching a Cursor cloud agent.
 */
export async function summarizeVercelDeployments(options: { limit?: number; target?: string; timeoutMs?: number } = {}): Promise<string> {
  if (!isVercelConfigured()) return VERCEL_NOT_CONFIGURED;
  return withTimeout(buildVercelSummary(options.limit || 5, options.target), options.timeoutMs, "Vercel deployment lookup timed out. Try again in a moment.");
}

async function buildVercelSummary(limit: number, target?: string): Promise<string> {
  let deployments: VercelDeployment[];
  try {
    deployments = await listVercelDeployments({ limit, target });
  } catch (error) {
    return `Could not load deployments from Vercel: ${describeError(error)}`;
  }
  if (!deployments.length) return target ? `No Vercel deployments found for target "${target}".` : "No Vercel deployments found yet.";

  return deployments
    .map((deployment) => {
      const when = deployment.created ?? deployment.createdAt;
      const ago = typeof when === "number" ? ` (${formatRelativeTime(when)})` : "";
      const scope = deployment.target ? ` ${deployment.target}` : "";
      const url = deployment.url ? ` — https://${deployment.url}` : "";
      return `* [${deploymentState(deployment)}]${scope} ${deployment.name || deployment.uid}${url}${ago}`;
    })
    .join("\n");
}
