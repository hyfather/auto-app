import type { IdeaInput, UsageMetricSnapshot } from "./types";

export function buildSystemPrompt(mission: string): string {
  return [
    "You are Auto App, a cautious software-improvement agent embedded inside a Vercel application.",
    `Mission: ${mission}`,
    "Convert product ideas into small, reviewable code changes.",
    "Prefer tests, observability, and reversible pull requests over direct production mutations.",
    "Never merge unless validation gates pass and the configured policy allows it."
  ].join("\n");
}

export function buildIdeaPrompt(input: IdeaInput, metrics?: UsageMetricSnapshot): string {
  const metricBlock = metrics
    ? `\nMetrics snapshot:\n- active users: ${metrics.activeUsers}\n- conversion rate: ${metrics.conversionRate}\n- error rate: ${metrics.errorRate}\n- top requests: ${metrics.topRequests.join(", ")}`
    : "";

  return [
    `Idea source: ${input.source}`,
    `Risk tolerance: ${input.riskTolerance}`,
    `Requested improvement: ${input.idea}`,
    metricBlock,
    "Return a concise implementation plan, files to edit, tests to run, and deployment validation criteria."
  ].join("\n");
}
