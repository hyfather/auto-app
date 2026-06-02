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

export const DEFAULT_CONSTRAINTS = [
  "Keep the diff small and PR-sized",
  "Prefer UI/copy changes before risky infrastructure changes",
  "Do not add an /admin UI",
  "Autonomously merge safe core PRs after the cloud agent, GitHub, and Vercel signals satisfy acceptance criteria",
  "Open a PR against main",
  "Include a short PR summary",
];

export const ACTIVE_CYCLE_STATUSES = [
  "observing",
  "proposed",
  "approved",
  "running",
  "waiting_for_agent",
  "pr_opened",
  "waiting_for_checks",
  "waiting_for_preview_deploy",
  "preview_deployed",
  "waiting_for_merge",
  "waiting_for_production_deploy",
  "production_deployed",
] as const;

export function formatCycleCode(cycleId: string) {
  return `AUTO-${cycleId.slice(-6).toUpperCase()}`;
}

export function visibleLog(cycleCode: string, label: string, body: string) {
  return `[${cycleCode}] ${label}\n${body.trim()}`;
}
