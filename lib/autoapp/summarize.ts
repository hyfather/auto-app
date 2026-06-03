import { getLatestTask } from "./task";
import { formatTaskCode } from "./policies";

export async function summarizeLatestTask() {
  const task = await getLatestTask();
  if (!task) return "No tasks have been created yet. Ask for a code change like `@autoapp add a pricing FAQ section`.";
  const code = formatTaskCode(task.id);
  const updates = task.memories.map((m) => `- ${m.classification}: ${m.normalizedText}`).join("\n") || "No related Slack updates recorded yet.";
  const nextStep = task.status === "completed" || task.status === "failed" || task.status === "cancelled"
    ? "This task is finished. Ask AutoApp for another change when you're ready."
    : "Watching #general for GitHub/Vercel updates while the Cursor cloud agent works.";
  return `[${code}] Summary\nStatus: ${task.status}.\nRequest: ${task.request}.${task.githubPrUrl ? `\nPR: ${task.githubPrUrl}` : ""}\nLatest related updates:\n${updates}\nNext step: ${nextStep}`;
}
