import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActiveTasks } from "@/lib/autoapp/task";
import { cancelTask, completeTask, requestAutonomousMergeIfReady } from "@/lib/autoapp/execute";
import { ACTIVE_TASK_STATUSES, formatTaskCode } from "@/lib/autoapp/policies";
import { runAutoappAgent, type AgentSource } from "@/lib/agent/runAgent";
import { HELP_TEXT } from "@/lib/agent/help";
import { classifySlackMessage, type ClassificationOutput } from "./classifySlackMessage";
import { parseToolUpdate } from "./parseToolUpdate";
import { postToGeneral } from "./postMessage";
import { syncTaskReaction } from "./reactions";
import { getThreadHistory } from "./threadHistory";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

type HandlerOptions = { threadTs?: string; sourceTs?: string; channelId?: string; botUserId?: string | null };

const SLASH_COMMAND_ACTOR = "slack-user";

/**
 * Run the tool-calling agent for one inbound message, loading the thread's
 * conversation history first so multi-turn dialogue (clarify → answer → act)
 * stays continuous. Database-schema errors are surfaced as a friendly setup
 * hint instead of throwing.
 */
async function respond(text: string, userId: string, source: AgentSource, options: HandlerOptions): Promise<string> {
  try {
    const history = await getThreadHistory(options.channelId, options.threadTs, options.botUserId, options.sourceTs);
    return await runAutoappAgent(text, {
      userId,
      source,
      history,
      threadTs: options.threadTs,
      sourceTs: options.sourceTs,
      channelId: options.channelId,
    });
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

/**
 * Entry point for the `/autoapp` slash command. Everything except `help` is
 * handed to the tool-calling agent, which decides which task/status tool to run.
 */
export async function handleAutoappCommand(text: string, userId: string = SLASH_COMMAND_ACTOR, options: HandlerOptions = {}): Promise<string> {
  const trimmed = text.trim();
  const command = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
  if (!trimmed || command === "help" || command === "controls") return HELP_TEXT;
  return respond(trimmed, userId, "command", options);
}

/** Entry point for `@autoapp` mentions. */
export async function handleMention(text: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  const cleaned = stripAutoappMention(text);
  if (!cleaned) return HELP_TEXT;
  return respond(cleaned, userId, "mention", options);
}

/**
 * Entry point for a plain human message in #general (top-level or a reply inside
 * a thread AutoApp is part of) that does not @mention AutoApp. AutoApp answers
 * every such message conversationally, just like Cursor's Slack integration.
 */
export async function handleChannelMessage(text: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  const cleaned = stripAutoappMention(text);
  if (!cleaned) return HELP_TEXT;
  return respond(cleaned, userId, "channel", options);
}

function stripAutoappMention(text: string) {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
}

/**
 * Emoji (reacji) that mean "cancel/stop this" when a user reacts to one of
 * AutoApp's task messages. Reacting with any of these on a message tied to an
 * active task cancels that task and stops its Cursor cloud agent.
 */
const CANCEL_REACTIONS = new Set([
  "x",
  "no_entry",
  "no_entry_sign",
  "octagonal_sign",
  "stop_sign",
  "no_good",
  "negative_squared_cross_mark",
  "wastebasket",
  "no_pedestrians",
]);

/**
 * Find the active task a reacted-to message belongs to. A reaction can land on
 * the originating request (the task's `slackRootTs`) or on any AutoApp log
 * posted inside that task's thread, so we map the message to its thread root
 * via `SlackMemory` and then look the task up by `slackRootTs`.
 */
async function findActiveTaskForMessage(messageTs: string) {
  const direct = await prisma.task.findFirst({ where: { slackRootTs: messageTs, status: { in: [...ACTIVE_TASK_STATUSES] } } });
  if (direct) return direct;
  const memory = await prisma.slackMemory.findFirst({ where: { messageTs }, select: { threadTs: true } });
  const root = memory?.threadTs;
  if (!root) return null;
  return prisma.task.findFirst({ where: { slackRootTs: root, status: { in: [...ACTIVE_TASK_STATUSES] } } });
}

/**
 * Interpret a reaction added to a message in #general as a control signal. A
 * cancel-style reacji on a message tied to an active task cancels that task.
 * Returns true when the reaction was consumed as a command (so the caller can
 * skip the generic "wake up" nudge for it). Never throws.
 */
export async function handleReactionCommand(reaction: string, messageTs: string | undefined, userId: string): Promise<boolean> {
  try {
    if (!messageTs || !CANCEL_REACTIONS.has(reaction)) return false;
    const task = await findActiveTaskForMessage(messageTs);
    if (!task) return false;
    await cancelTask(task.id, userId, messageTs);
    await postToGeneral(`Cancelled ${formatTaskCode(task.id)} because of your :${reaction}: reaction.`, task.slackRootTs || undefined);
    return true;
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return false;
    console.error("[Slack reactions] Failed to handle reaction command:", error instanceof Error ? error.message : error);
    return false;
  }
}

export type RecordedSlackMessage = ClassificationOutput & { isDuplicate: boolean };

/**
 * A single user message can reach us as more than one Slack event (most notably
 * an `@autoapp` mention arrives as BOTH an `app_mention` and a `message.channels`
 * twin with the same `ts`). They race on the unique `(channelId, messageTs)`
 * index, so we insert with `create` and treat a unique-constraint conflict as a
 * benign duplicate: the row already exists. `isDuplicate` lets callers respond
 * exactly once instead of doubling up (or, when the loser previously threw,
 * silently dropping the reply).
 */
export async function recordSlackMessage(
  event: { text?: string; user?: string; bot_id?: string; channel?: string; ts?: string; thread_ts?: string },
  selfUserId?: string | null,
): Promise<RecordedSlackMessage> {
  const tool = parseToolUpdate(event.text || "");
  // With several tasks in flight, attribute a GitHub/Vercel/Cursor update to the
  // task it actually references (by PR URL, thread, or AUTO-XXXXXX code) before
  // falling back to the most recent active task.
  const target = await resolveTaskForUpdate(event.text || "", tool, event.thread_ts);
  const classified = classifySlackMessage({ text: event.text || "", authorId: event.user, botId: event.bot_id, channelId: event.channel, ts: event.ts, recentTaskId: target?.id, selfUserId });
  if (!event.channel || !event.ts) return { ...classified, isDuplicate: false };

  let isDuplicate = false;
  try {
    await prisma.slackMemory.create({
      data: { channelId: event.channel, messageTs: event.ts, threadTs: event.thread_ts, authorId: event.user || event.bot_id || "unknown", authorType: classified.authorType, rawText: event.text || "", normalizedText: (event.text || "").replace(/\s+/g, " ").trim(), classification: classified.classification, importance: classified.importance, relatedTaskId: classified.relatedTaskId || undefined, extractedPrUrl: classified.extractedPrUrl, extractedDeploymentUrl: classified.extractedDeploymentUrl, extractedTaskCode: classified.extractedTaskCode },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    isDuplicate = true;
  }

  // Only the first event for a given message records integration/tool side
  // effects, so a duplicate twin event never double-posts a tool update.
  if (!isDuplicate && tool.source !== "unknown") {
    await prisma.integrationEvent.create({ data: { source: tool.source, eventType: tool.eventType, payload: toJsonPayload(tool), relatedTaskId: target?.id } });
    if (target) await updateTaskFromTool(target.id, tool);
  }
  return { ...classified, isDuplicate };
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
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
  if (task) await syncTaskReaction(task.slackRootTs, task.status);
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
