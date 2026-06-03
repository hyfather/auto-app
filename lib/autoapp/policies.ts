/**
 * Default areas the implementation worker must never touch. These become the
 * "Don't" half of the do/don't guardrails injected into every task prompt.
 */
export const DEFAULT_FORBIDDEN_AREAS = [
  "auth",
  "secrets",
  "env vars",
  "billing",
  "production database writes",
  "GitHub Actions",
  "Vercel deployment config",
  "Slack app permissions",
  "database migrations unless explicitly approved",
];

/**
 * The "Do" half of the guardrails injected into every task prompt. These keep
 * the cloud agent's change small, reviewable, and shippable.
 */
export const DEFAULT_DOS = [
  "Keep the diff small and focused",
  "Open a pull request against the default branch with a short, descriptive summary",
  "Verify the changed behavior before opening or updating the PR",
  "Do not add an /admin UI",
];

/** Task statuses that count as "in flight" against the parallelism cap. */
export const ACTIVE_TASK_STATUSES = [
  "queued",
  "waiting_for_agent",
  "pr_opened",
  "waiting_for_checks",
  "waiting_for_preview_deploy",
  "preview_deployed",
  "waiting_for_merge",
  "waiting_for_production_deploy",
  "production_deployed",
] as const;

export function formatTaskCode(taskId: string) {
  return `AUTO-${taskId.slice(-6).toUpperCase()}`;
}

export function visibleLog(taskCode: string, label: string, body: string) {
  return `[${taskCode}] ${label}\n${body.trim()}`;
}
