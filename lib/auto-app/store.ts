import { createImprovementPlan } from "./harness";
import type { AuditAction, AuditEvent, IdeaInput, ImprovementRun, RunStatus } from "./types";

const runs = new Map<string, ImprovementRun>();

export async function createRun(idea: IdeaInput, actor = idea.operatorId): Promise<ImprovementRun> {
  const plan = await createImprovementPlan(idea);
  const status: RunStatus = plan.policy.blocked ? "blocked" : plan.policy.requiresHumanApproval ? "needs-approval" : "approved";
  const now = new Date().toISOString();
  const run: ImprovementRun = {
    id: plan.id,
    status,
    idea,
    plan,
    audit: [],
    createdAt: now,
    updatedAt: now
  };
  run.audit.push(makeAudit(run.id, "created", actor, "Improvement request captured."));
  run.audit.push(makeAudit(run.id, "triaged", "policy-engine", plan.policy.reasons.join(" ")));
  runs.set(run.id, run);
  return run;
}

export function listRuns(): ImprovementRun[] {
  return [...runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getRun(id: string): ImprovementRun | undefined {
  return runs.get(id);
}

export function approveRun(id: string, actor: string, reason: string): ImprovementRun {
  const run = requireRun(id);
  run.status = "approved";
  run.approvedAt = new Date().toISOString();
  touch(run);
  run.audit.push(makeAudit(id, "approved", actor, reason));
  return run;
}

export function rejectRun(id: string, actor: string, reason: string): ImprovementRun {
  const run = requireRun(id);
  run.status = "rejected";
  run.rejectedAt = new Date().toISOString();
  touch(run);
  run.audit.push(makeAudit(id, "rejected", actor, reason));
  return run;
}

export function dispatchRun(id: string, actor: string, reason: string): ImprovementRun {
  const run = requireRun(id);
  if (run.status !== "approved") {
    throw new Error(`Run ${id} must be approved before dispatch.`);
  }

  run.status = "running";
  touch(run);
  run.audit.push(makeAudit(id, "dispatched", actor, reason));
  return run;
}

export function validateRun(id: string, actor: string, reason: string, checks: string[]): ImprovementRun {
  const run = requireRun(id);
  if (run.status !== "approved" && run.status !== "running") {
    throw new Error(`Run ${id} must be approved or running before validation.`);
  }

  run.status = "ready-to-merge";
  touch(run);
  run.audit.push(makeAudit(id, "validated", actor, `${reason} Checks: ${checks.join(", ") || "not specified"}`));
  return run;
}

export function mergeRun(id: string, actor: string, reason: string): ImprovementRun {
  const run = requireRun(id);
  if (run.status !== "ready-to-merge") {
    throw new Error(`Run ${id} must be ready-to-merge before merge.`);
  }

  if (run.plan.dryRun) {
    run.audit.push(makeAudit(id, "blocked", actor, "Dry-run plans cannot be merged."));
    touch(run);
    throw new Error(`Run ${id} is dry-run only and cannot merge.`);
  }

  run.status = "merged";
  touch(run);
  run.audit.push(makeAudit(id, "merged", actor, reason));
  return run;
}

export function recordAgentLoop(runIds: string[], actor: string, reason: string): void {
  for (const id of runIds) {
    const run = runs.get(id);
    if (!run) continue;
    run.audit.push(makeAudit(id, "agent-loop", actor, reason));
    touch(run);
  }
}

function requireRun(id: string): ImprovementRun {
  const run = runs.get(id);
  if (!run) {
    throw new Error(`Unknown improvement run: ${id}`);
  }
  return run;
}

function touch(run: ImprovementRun) {
  run.updatedAt = new Date().toISOString();
}

function makeAudit(runId: string, action: AuditAction, actor: string, reason: string): AuditEvent {
  return {
    id: crypto.randomUUID(),
    runId,
    action,
    actor,
    reason,
    createdAt: new Date().toISOString()
  };
}
