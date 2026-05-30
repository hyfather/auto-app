import { createRun } from "./store";
import type { AgentLoopInput, AgentLoopResult, IdeaInput, ResearchFinding, UsageMetricSnapshot } from "./types";

export async function runAgenticDiscovery(input: AgentLoopInput, metrics: UsageMetricSnapshot): Promise<AgentLoopResult> {
  const findings = collectFindings(input.mission, metrics, input.includeInternetResearch);
  const ideas = findings.slice(0, input.maxIdeas).map((finding): IdeaInput => ({
    idea: ideaFromFinding(finding),
    mission: input.mission,
    source: ideaSourceFromFinding(finding),
    riskTolerance: finding.confidence === "high" ? "medium" : "low",
    dryRun: input.dryRun,
    operatorId: "agent-loop",
    approvalMode: "human-required"
  }));
  const runs = await Promise.all(ideas.map((idea) => createRun(idea, "agent-loop")));

  return {
    generatedAt: new Date().toISOString(),
    mission: input.mission,
    findings,
    ideas,
    runIds: runs.map((run) => run.id),
    internetResearch: input.includeInternetResearch ? "queued" : "disabled"
  };
}

export function collectFindings(
  mission: string,
  metrics: UsageMetricSnapshot,
  includeInternetResearch: boolean
): ResearchFinding[] {
  const findings: ResearchFinding[] = [
    {
      topic: "operator mission",
      signal: `Keep future work tightly aligned to: ${mission}`,
      confidence: "high",
      source: "operator-mission"
    }
  ];

  if (metrics.errorRate > 0.02) {
    findings.push({
      topic: "reliability",
      signal: `Error rate is ${(metrics.errorRate * 100).toFixed(1)}%; prioritize resilience and observability before growth work.`,
      confidence: "high",
      source: "usage-metrics"
    });
  }

  if (metrics.conversionRate < 0.1) {
    findings.push({
      topic: "activation",
      signal: `Conversion rate is ${(metrics.conversionRate * 100).toFixed(1)}%; improve first-run guidance and idea-to-plan clarity.`,
      confidence: "medium",
      source: "usage-metrics"
    });
  }

  for (const request of metrics.topRequests.slice(0, 3)) {
    findings.push({
      topic: "user request",
      signal: `Users are asking for: ${request}.`,
      confidence: "medium",
      source: "usage-metrics"
    });
  }

  if (includeInternetResearch) {
    findings.push({
      topic: "internet research",
      signal: "Queue a research subagent to compare the app against current market patterns before code generation.",
      confidence: "medium",
      source: "internet-research"
    });
  }

  return findings;
}

function ideaSourceFromFinding(finding: ResearchFinding): IdeaInput["source"] {
  if (finding.source === "operator-mission") {
    return "scheduled-agent";
  }

  return finding.source;
}

function ideaFromFinding(finding: ResearchFinding): string {
  switch (finding.topic) {
    case "reliability":
      return "Add an admin reliability panel with recent errors, validation failures, and rollback guidance.";
    case "activation":
      return "Improve onboarding so a new operator can submit an idea, inspect the generated plan, and understand next approval steps.";
    case "internet research":
      return "Add a guarded research-agent step that summarizes current best practices before proposing implementation changes.";
    default:
      return `Turn this signal into a scoped product improvement: ${finding.signal}`;
  }
}
