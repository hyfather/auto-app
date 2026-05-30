import type { IdeaInput, PolicyDecision, RiskLevel } from "./types";

const HIGH_RISK_TERMS = ["payment", "billing", "delete", "password", "auth", "merge automatically", "production data"];
const MEDIUM_RISK_TERMS = ["email", "notification", "personal", "contacts", "analytics", "internet"];

export function evaluateIdeaPolicy(input: IdeaInput): PolicyDecision {
  const haystack = `${input.idea} ${input.mission}`.toLowerCase();
  const highHits = HIGH_RISK_TERMS.filter((term) => haystack.includes(term));
  const mediumHits = MEDIUM_RISK_TERMS.filter((term) => haystack.includes(term));
  const risk: RiskLevel = input.riskTolerance === "high" || highHits.length > 0 ? "high" : mediumHits.length > 0 ? "medium" : input.riskTolerance;
  const requiresHumanApproval = input.approvalMode !== "auto-low-risk" || risk !== "low";
  const reasons = [
    ...highHits.map((term) => `High-risk term detected: ${term}`),
    ...mediumHits.map((term) => `Sensitive product area detected: ${term}`)
  ];

  if (requiresHumanApproval) {
    reasons.push("Human approval is required by the configured approval mode or risk level.");
  } else {
    reasons.push("Low-risk change is eligible for autonomous execution after validation gates pass.");
  }

  return {
    risk,
    requiresHumanApproval,
    reasons,
    blocked: risk === "high" && input.approvalMode === "fully-manual"
  };
}
