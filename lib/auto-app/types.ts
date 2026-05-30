import { z } from "zod";

export const ideaSchema = z.object({
  idea: z.string().trim().min(12, "Describe the product change in at least 12 characters."),
  mission: z.string().trim().min(12, "Describe the mission in at least 12 characters."),
  source: z.enum(["human", "usage-metrics", "internet-research", "scheduled-agent"]).default("human"),
  riskTolerance: z.enum(["low", "medium", "high"]).default("low"),
  dryRun: z.boolean().default(true),
  operatorId: z.string().trim().min(1).default("anonymous"),
  approvalMode: z.enum(["human-required", "auto-low-risk", "fully-manual"]).default("human-required")
});

export const adminRunCommandSchema = z.object({
  reason: z.string().trim().min(8, "Explain why this admin action is safe and useful."),
  actor: z.string().trim().min(1).optional(),
  checks: z.array(z.string().trim().min(1)).default([])
});

export const agentLoopSchema = z.object({
  mission: z.string().trim().min(12),
  dryRun: z.boolean().default(true),
  maxIdeas: z.number().int().min(1).max(5).default(3),
  includeInternetResearch: z.boolean().default(false)
});

export type IdeaInput = z.infer<typeof ideaSchema>;
export type AdminRunCommand = z.infer<typeof adminRunCommandSchema>;
export type AgentLoopInput = z.infer<typeof agentLoopSchema>;

export type ImprovementStage =
  | "capture"
  | "triage"
  | "plan"
  | "implement"
  | "validate"
  | "open-pr"
  | "observe-preview"
  | "merge";

export type RiskLevel = "low" | "medium" | "high";
export type RunStatus = "queued" | "needs-approval" | "approved" | "running" | "blocked" | "ready-to-merge" | "merged" | "rejected";
export type AuditAction =
  | "created"
  | "triaged"
  | "approved"
  | "rejected"
  | "agent-loop"
  | "dispatched"
  | "validated"
  | "blocked"
  | "merged";

export interface PolicyDecision {
  risk: RiskLevel;
  requiresHumanApproval: boolean;
  reasons: string[];
  blocked: boolean;
}

export interface ImprovementPlan {
  id: string;
  title: string;
  mission: string;
  source: IdeaInput["source"];
  dryRun: boolean;
  createdAt: string;
  modelPreference: "opus-4.8" | "codex-5.5" | "provider-default";
  policy: PolicyDecision;
  stages: Array<{
    stage: ImprovementStage;
    status: "ready" | "blocked" | "manual-gate";
    summary: string;
  }>;
  safetyGates: string[];
  validationCommands: string[];
  github?: {
    owner: string;
    repo: string;
    baseBranch: string;
    branchName: string;
  };
}

export interface UsageMetricSnapshot {
  activeUsers: number;
  conversionRate: number;
  errorRate: number;
  topRequests: string[];
  collectedAt: string;
}

export interface ResearchFinding {
  topic: string;
  signal: string;
  confidence: RiskLevel;
  source: "usage-metrics" | "operator-mission" | "internet-research";
}

export interface AgentLoopResult {
  generatedAt: string;
  mission: string;
  findings: ResearchFinding[];
  ideas: IdeaInput[];
  runIds: string[];
  internetResearch: "disabled" | "queued";
}

export interface AuditEvent {
  id: string;
  runId: string;
  action: AuditAction;
  actor: string;
  reason: string;
  createdAt: string;
}

export interface ImprovementRun {
  id: string;
  status: RunStatus;
  idea: IdeaInput;
  plan: ImprovementPlan;
  audit: AuditEvent[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
}
