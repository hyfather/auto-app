export type ToolUpdate = {
  source: "github" | "vercel" | "unknown";
  eventType: string;
  prUrl?: string;
  deploymentUrl?: string;
  status?: string;
};

const urlPattern = /https?:\/\/[^\s>)]+/gi;
const prPattern = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;
const deploymentPattern = /https?:\/\/[^\s>)]*(?:vercel\.app|vercel\.com)[^\s>)]*/i;

export function parseToolUpdate(text: string): ToolUpdate {
  const normalized = text.toLowerCase();
  const prUrl = text.match(prPattern)?.[0];
  const deploymentUrl = text.match(deploymentPattern)?.[0] || text.match(urlPattern)?.find((url) => /vercel/i.test(url));

  if (/github|pull request|\bpr\b|checks?|merged|branch/i.test(text)) {
    if (/check/.test(normalized) && /pass|success|succeed|green/.test(normalized)) return { source: "github", eventType: "checks_passed", prUrl, status: "passed" };
    if (/check/.test(normalized) && /fail|red|error/.test(normalized)) return { source: "github", eventType: "checks_failed", prUrl, status: "failed" };
    if (/check/.test(normalized) && /start|running|pending/.test(normalized)) return { source: "github", eventType: "checks_started", prUrl, status: "started" };
    if (/merged/.test(normalized)) return { source: "github", eventType: "pr_merged", prUrl, status: "merged" };
    if (/updated|synchronize|pushed/.test(normalized)) return { source: "github", eventType: "pr_updated", prUrl, status: "updated" };
    if (/opened|created/.test(normalized)) return { source: "github", eventType: "pr_opened", prUrl, status: "opened" };
    return { source: "github", eventType: "github_update", prUrl };
  }

  if (/vercel|deployment|deployed|preview|production/i.test(text)) {
    const target = /production|main/.test(normalized) ? "production" : "preview";
    if (/fail|error|canceled|cancelled/.test(normalized)) return { source: "vercel", eventType: `${target}_deployment_failed`, deploymentUrl, status: "failed" };
    if (/ready|succeed|success|deployed|complete/.test(normalized)) return { source: "vercel", eventType: `${target}_deployment_ready`, deploymentUrl, status: "ready" };
    if (/start|building|queued|deploying/.test(normalized)) return { source: "vercel", eventType: `${target}_deployment_started`, deploymentUrl, status: "started" };
    return { source: "vercel", eventType: "deployment_unknown", deploymentUrl, status: "unknown" };
  }

  return { source: "unknown", eventType: "unknown" };
}
