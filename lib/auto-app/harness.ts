import { getHarnessConfig, type HarnessConfig } from "./config";
import { evaluateIdeaPolicy } from "./policy";
import { buildIdeaPrompt, buildSystemPrompt } from "./prompts";
import type { IdeaInput, ImprovementPlan, UsageMetricSnapshot } from "./types";

const DEFAULT_VALIDATION_COMMANDS = ["npm run typecheck", "npm run build", "npm run test:harness"];

export async function createImprovementPlan(
  input: IdeaInput,
  metrics?: UsageMetricSnapshot,
  config: HarnessConfig = getHarnessConfig()
): Promise<ImprovementPlan> {
  const id = crypto.randomUUID();
  const branchName = `auto-app/${slugify(input.idea)}-${id.slice(0, 8)}`;
  const hasGithub = Boolean(config.githubOwner && config.githubRepo && config.githubToken);
  const hasModel = Boolean(config.openaiApiKey || config.anthropicApiKey);
  const systemPrompt = buildSystemPrompt(input.mission);
  const ideaPrompt = buildIdeaPrompt(input, metrics);
  const policy = evaluateIdeaPolicy(input);

  return {
    id,
    title: titleFromIdea(input.idea),
    mission: input.mission,
    source: input.source,
    dryRun: input.dryRun,
    createdAt: new Date().toISOString(),
    modelPreference: config.modelPreference,
    policy,
    stages: [
      {
        stage: "capture",
        status: "ready",
        summary: "The idea has been normalized into a durable improvement request."
      },
      {
        stage: "triage",
        status: policy.blocked ? "blocked" : policy.requiresHumanApproval ? "manual-gate" : "ready",
        summary: `Policy classified this as ${policy.risk} risk. ${policy.reasons.join(" ")}`
      },
      {
        stage: "plan",
        status: hasModel && !policy.blocked ? "ready" : "blocked",
        summary: hasModel
          ? `Ready to ask ${config.modelPreference} for a patch plan using ${systemPrompt.length + ideaPrompt.length} prompt characters.`
          : "Set OPENAI_API_KEY or ANTHROPIC_API_KEY so the harness can ask a coding model for a patch plan."
      },
      {
        stage: "implement",
        status: hasModel && !policy.blocked ? "manual-gate" : "blocked",
        summary: "Generate code in a temporary branch/worktree, constrained to the plan and repository policy."
      },
      {
        stage: "validate",
        status: "manual-gate",
        summary: `Run ${DEFAULT_VALIDATION_COMMANDS.join(", ")} plus product-specific preview checks before a PR can merge.`
      },
      {
        stage: "open-pr",
        status: hasGithub ? "manual-gate" : "blocked",
        summary: hasGithub
          ? `Create a GitHub pull request from ${branchName} into ${config.baseBranch}.`
          : "Set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN so the harness can create PRs."
      },
      {
        stage: "observe-preview",
        status: "manual-gate",
        summary: "Wait for the Vercel branch deployment, smoke-test it, and compare metrics against the mission."
      },
      {
        stage: "merge",
        status: "manual-gate",
        summary: "Only merge when tests, Vercel preview checks, and configured human/agent gates pass."
      }
    ],
    safetyGates: [
      "dry-run by default",
      "admin token required for control-plane actions",
      "policy triage before implementation",
      "small pull requests only",
      "no direct commits to production branch",
      "validation commands must pass",
      "human approval required for high-risk changes"
    ],
    validationCommands: DEFAULT_VALIDATION_COMMANDS,
    github: config.githubOwner && config.githubRepo
      ? {
          owner: config.githubOwner,
          repo: config.githubRepo,
          baseBranch: config.baseBranch,
          branchName
        }
      : undefined
  };
}

export async function openDraftPullRequest(plan: ImprovementPlan, body: string, config = getHarnessConfig()) {
  if (plan.dryRun) {
    return { dryRun: true, url: undefined, message: "Dry run enabled; no GitHub API call was made." };
  }

  if (!config.githubToken || !plan.github) {
    throw new Error("GitHub configuration is incomplete.");
  }

  const response = await fetch(`https://api.github.com/repos/${plan.github.owner}/${plan.github.repo}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      title: plan.title,
      head: plan.github.branchName,
      base: plan.github.baseBranch,
      body,
      draft: true
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub pull request creation failed: ${response.status} ${await response.text()}`);
  }

  const pullRequest = (await response.json()) as { html_url?: string };
  return { dryRun: false, url: pullRequest.html_url, message: "Draft pull request created." };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "idea";
}

function titleFromIdea(idea: string): string {
  const trimmed = idea.trim().replace(/\s+/g, " ");
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
}
