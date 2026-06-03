import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActiveTasks } from "@/lib/autoapp/task";
import { completeTask, requestAutonomousMergeIfReady } from "@/lib/autoapp/execute";
import { runAutoappAgent } from "@/lib/agent/runAgent";
import { HELP_TEXT } from "@/lib/agent/help";
import { classifySlackMessage } from "./classifySlackMessage";
import { parseToolUpdate } from "./parseToolUpdate";
import { postToGeneral } from "./postMessage";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

type HandlerOptions = { threadTs?: string; sourceTs?: string };

const SLASH_COMMAND_ACTOR = "slack-user";

/**
 * Entry point for the `/autoapp` slash command. Everything except `help` is
 * handed to the tool-calling agent, which decides which task/status tool to run.
 */
export async function handleAutoappCommand(text: string, userId: string = SLASH_COMMAND_ACTOR, options: HandlerOptions = {}): Promise<string> {
  try {
    const trimmed = text.trim();
    const command = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
    if (!trimmed || command === "help" || command === "controls") return HELP_TEXT;
    return await runAutoappAgent(trimmed, { userId, threadTs: options.threadTs, sourceTs: options.sourceTs });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

/** Entry point for `@autoapp` mentions and conversational thread replies. */
export async function handleMention(text: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  try {
    const cleaned = stripAutoappMention(text);
    if (!cleaned) return HELP_TEXT;
    return await runAutoappAgent(cleaned, { userId, threadTs: options.threadTs, sourceTs: options.sourceTs });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

function stripAutoappMention(text: string) {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
}

export async function recordSlackMessage(event: { text?: string; user?: string; bot_id?: string; channel?: string; ts?: string; thread_ts?: string }) {
  const tool = parseToolUpdate(event.text || "");
  // With several tasks in flight, attribute a GitHub/Vercel/Cursor update to the
  // task it actually references (by PR URL, thread, or AUTO-XXXXXX code) before
  // falling back to the most recent active task.
  const target = await resolveTaskForUpdate(event.text || "", tool, event.thread_ts);
  const classified = classifySlackMessage({ text: event.text || "", authorId: event.user, botId: event.bot_id, channelId: event.channel, ts: event.ts, recentTaskId: target?.id });
  if (!event.channel || !event.ts) return classified;
  const memory = await prisma.slackMemory.upsert({
    where: { channelId_messageTs: { channelId: event.channel, messageTs: event.ts } },
    update: {},
    create: { channelId: event.channel, messageTs: event.ts, threadTs: event.thread_ts, authorId: event.user || event.bot_id || "unknown", authorType: classified.authorType, rawText: event.text || "", normalizedText: (event.text || "").replace(/\s+/g, " ").trim(), classification: classified.classification, importance: classified.importance, relatedTaskId: classified.relatedTaskId || undefined, extractedPrUrl: classified.extractedPrUrl, extractedDeploymentUrl: classified.extractedDeploymentUrl, extractedTaskCode: classified.extractedTaskCode },
  });
  if (tool.source !== "unknown") {
    await prisma.integrationEvent.create({ data: { source: tool.source, eventType: tool.eventType, payload: toJsonPayload(tool), relatedTaskId: target?.id } });
    if (target) await updateTaskFromTool(target.id, tool);
  }
  return { ...classified, memory };
}

/**
 * Pick which active task a passive Cursor/GitHub/Vercel Slack update belongs to.
 * Prefers an exact PR-URL match, then the AUTO-XXXXXX code in the text, then the
 * Slack thread root, and finally the most recent active task.
 */
async function resolveTaskForUpdate(text: string, tool: ReturnType<typeof parseToolUpdate>, threadTs?: string): Promise<{ id: string } | null> {
  const tasks = await getActiveTasks();
  if (!tasks.length) return null;

  if (tool.prUrl) {
    const byPr = tasks.find((task) => task.githubPrUrl === tool.prUrl);
    if (byPr) return byPr;
  }
  const code = text.match(/AUTO-?([A-Z0-9]{3,})/i)?.[1]?.toUpperCase();
  if (code) {
    const byCode = tasks.find((task) => task.id.slice(-6).toUpperCase() === code || task.id.toUpperCase().endsWith(code));
    if (byCode) return byCode;
  }
  if (threadTs) {
    const byThread = tasks.find((task) => task.slackRootTs === threadTs);
    if (byThread) return byThread;
  }
  return tasks[tasks.length - 1];
}

async function updateTaskFromTool(taskId: string, tool: ReturnType<typeof parseToolUpdate>) {
  const data: Record<string, string | undefined> = {};
  if (tool.prUrl) data.githubPrUrl = tool.prUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("preview")) data.vercelPreviewUrl = tool.deploymentUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("production")) data.vercelProductionUrl = tool.deploymentUrl;
  const statusMap: Record<string, string> = { pr_opened: "pr_opened", pr_updated: "pr_opened", run_failed: "failed", checks_started: "waiting_for_checks", checks_passed: "waiting_for_preview_deploy", checks_failed: "failed", pr_merged: "completed", preview_deployment_started: "waiting_for_preview_deploy", preview_deployment_ready: "preview_deployed", preview_deployment_failed: "failed", production_deployment_started: "waiting_for_production_deploy", production_deployment_ready: "completed", production_deployment_failed: "failed" };
  if (statusMap[tool.eventType]) data.status = statusMap[tool.eventType];
  if (Object.keys(data).length) await prisma.task.update({ where: { id: taskId }, data });
  await logAutoappEvent("tool_update", { taskId, tool });
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  const threadTs = task?.slackRootTs || undefined;
  await postToGeneral(`[${tool.source}] ${tool.eventType}${tool.prUrl ? ` — ${tool.prUrl}` : ""}${tool.deploymentUrl ? ` — ${tool.deploymentUrl}` : ""}`, threadTs);
  if (["pr_opened", "pr_updated", "run_finished", "checks_passed", "preview_deployment_ready"].includes(tool.eventType)) await requestAutonomousMergeIfReady(taskId);
  // A merged PR on main is the success condition: the change is live on the
  // default branch, so close the loop on merge instead of waiting for a separate
  // production-deploy notification (which may never arrive).
  if (tool.eventType === "pr_merged") {
    await completeTask(taskId, `${tool.prUrl ? `Pull request ${tool.prUrl}` : "The pull request"} is merged into main, so the change is live on the default branch. Marking this task successful.`);
  } else if (tool.eventType === "production_deployment_ready") {
    await completeTask(taskId, "Production deployment is ready after the autonomous PR merge.");
  }
}

async function logAutoappEvent(eventType: string, payload: Record<string, unknown>) {
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType, payload: toJsonPayload(payload) } });
}

function toJsonPayload(payload: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonObject;
}
