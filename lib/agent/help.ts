import { MAX_ACTIVE_TASKS } from "@/lib/autoapp/task";

export const HELP_TEXT = [
  "*AutoApp controls*",
  `AutoApp turns your requests into code changes implemented by Cursor cloud agents that open and auto-merge PRs. It runs up to ${MAX_ACTIVE_TASKS} tasks in parallel; extra requests are turned away until a slot frees up.`,
  "Just describe what you want, e.g. `@autoapp make the landing page default to light mode`, and AutoApp queues a task and launches a Cursor cloud agent.",
  "",
  "*Manage tasks (`/autoapp` slash command or `@autoapp` mention):*",
  "• `/autoapp queue` — list every queued/in-flight task with its `AUTO-XXXXXX` code, status, and PR link.",
  "• `/autoapp new <request>` — start a new focused code change (alias: just type the request).",
  "• `/autoapp update <task> <new instructions>` — revise a task (`<task>` is its code or queue slot like `#2`).",
  "• `/autoapp cancel <task>` — cancel one task and stop its Cursor agent.",
  "• `/autoapp cancel all` — cancel every active task.",
  "",
  "*Status (`/autoapp` slash command):*",
  "• `/autoapp status` — task queue (N/5) plus open PRs with checks and the last deployment.",
  "• `/autoapp prs [open|closed|all]` — list pull requests with their state and CI checks.",
  "• `/autoapp deployments` — show the last deployment and its state.",
  "• `/autoapp evaluate` — review the current state of the live app.",
  "",
  "Mentions like `@autoapp queue`, `@autoapp cancel AUTO-AB12CD`, `@autoapp status`, and `@autoapp add a pricing FAQ` all work too and stay in the Slack thread.",
].join("\n");
