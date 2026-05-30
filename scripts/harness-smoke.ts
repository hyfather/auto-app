import assert from "node:assert/strict";
import { createImprovementPlan } from "../lib/auto-app/harness";

const plan = await createImprovementPlan({
  idea: "Build a birthday greeting card app that learns preferred styles from successful sends.",
  mission: "Help operators turn useful app ideas into safe, reviewed, deployable software improvements.",
  source: "human",
  riskTolerance: "low",
  dryRun: true,
  operatorId: "smoke-test",
  approvalMode: "human-required"
});

assert.equal(plan.dryRun, true);
assert.equal(plan.stages.at(0)?.stage, "capture");
assert.equal(plan.policy.requiresHumanApproval, true);
assert.ok(plan.safetyGates.includes("dry-run by default"));
assert.ok(plan.validationCommands.includes("npm run build"));
console.log(`Created dry-run improvement plan ${plan.id}`);
