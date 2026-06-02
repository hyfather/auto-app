import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActiveCycle } from "@/lib/autoapp/cycle";
import { approveAndRequestAgent, autonomouslyApproveAndRequestAgent, completeCycle, rejectCycle, requestAutonomousMergeIfReady, requestQuickChangeAgent } from "@/lib/autoapp/execute";
import { abortActiveMission, getActiveMission, incorporateMissionInput, pauseMission, resumeLatestMission, setActiveMission } from "@/lib/autoapp/mission";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { summarizeLatestCycle } from "@/lib/autoapp/summarize";
import { classifySlackMessage } from "./classifySlackMessage";
import { answerGeneralQuestion, classifySlackMentionIntent, SlackIntentUnavailableError } from "./intent";
import { parseToolUpdate } from "./parseToolUpdate";
import { postToGeneral } from "./postMessage";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

const HELP_TEXT = "AutoApp controls: `@autoapp start [mission]`, `status`, `mission`, `set mission to <text>`, `pause`, `resume`, `abort`, `summarize`, `help`. Ask for a focused code change, like `@autoapp make the landing page default to light mode`, and AutoApp will launch Cursor without changing the mission. Slash commands still work: `/autoapp status`, `/autoapp start <mission>`, `/autoapp abort`. Mention replies always stay in the Slack thread and AutoApp streams OODA progress there.";

type HandlerOptions = { threadTs?: string; sourceTs?: string };

// Confidence floor for acting on a classified slash-command intent, matching
// the mention path in handleMention.
const FREEFORM_INTENT_CONFIDENCE_THRESHOLD = 0.55;
const SLASH_COMMAND_ACTOR = "slack-user";

export async function handleAutoappCommand(text: string, userId: string = SLASH_COMMAND_ACTOR): Promise<string> {
  try {
    return await handleAutoappCommandUnsafe(text, userId);
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

async function handleAutoappCommandUnsafe(text: string, userId: string): Promise<string> {
  const trimmed = text.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch ((command || "help").toLowerCase()) {
    case "help":
    case "controls":
      return HELP_TEXT;
    case "status":
      return getStatusText();
    case "mission": {
      const mission = await getActiveMission();
      return mission ? `Current mission: ${mission.title}\nStatus: ${mission.status}\nGuidance:\n${mission.description}` : "No active mission. Use `/autoapp set-mission <mission>` or say `@autoapp start <mission>`.";
    }
    case "set-mission": {
      const mission = await setActiveMission(arg);
      await logAutoappEvent("mission_set", { missionId: mission.id, title: mission.title, source: "slash_command" });
      return `[Mission update]\nCurrent mission is now: ${mission.title}\nI can start an OODA cycle now with \`/autoapp start ${mission.title}\` or \`@autoapp start\`.`;
    }
    case "start": {
      if (arg) await setActiveMission(arg);
      return startAutonomousCycleText();
    }
    case "propose":
      return startAutonomousCycleText();
    case "pause":
      await pauseMission();
      await logAutoappEvent("mission_paused", { source: "slash_command" });
      return "[Control]\nAutoApp is paused. Slash commands and mentions still work; use `resume` to continue or `abort` to discard the mission and active cycle.";
    case "resume": {
      const mission = await resumeLatestMission();
      await logAutoappEvent("mission_resumed", { missionId: mission?.id, source: "slash_command" });
      return mission ? `AutoApp resumed mission: ${mission.title}` : "No paused mission found to resume.";
    }
    case "abort":
    case "reset":
    case "fresh-start":
      return abortMissionText("slash_command");
    case "summarize":
      return summarizeLatestCycle();
    default:
      return routeFreeformSlashCommand(trimmed, userId);
  }
}

/**
 * Route freeform slash-command text (anything that is not a known subcommand)
 * through the same intent classifier the mention path uses. Without this, a
 * focused code-change request such as `/autoapp change theme to light
 * background` was silently folded into mission guidance and never launched a
 * Cursor cloud agent. Code-change requests now dispatch an agent; everything
 * else preserves the historical mission-guidance behavior.
 */
async function routeFreeformSlashCommand(text: string, userId: string): Promise<string> {
  const cleaned = stripAutoappMention(text);
  if (!cleaned) return HELP_TEXT;

  let intent;
  try {
    intent = await classifySlackMentionIntent(cleaned);
  } catch (error) {
    // If intent routing is unavailable (e.g. no OpenAI key), keep working by
    // folding the text into the active mission's guidance like before.
    if (error instanceof SlackIntentUnavailableError) return incorporateGuidanceAndMaybeStart(text);
    throw error;
  }

  if (intent.kind === "code_change" && intent.confidence >= FREEFORM_INTENT_CONFIDENCE_THRESHOLD) {
    return startQuickChangeCycleText(intent.request, userId);
  }

  return incorporateGuidanceAndMaybeStart(text);
}

export async function getStatusText() {
  const mission = await getActiveMission();
  const cycle = await getActiveCycle();
  const snapshot = mission ? await prisma.webAppSnapshot.findFirst({ where: { missionId: mission.id }, orderBy: { createdAt: "desc" } }) : null;
  const recentLogs = await prisma.integrationEvent.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  return `[Status]\nMission: ${mission?.title ? `"${mission.title}"` : "none"}\nMission status: ${mission?.status || "n/a"}\nLatest web app snapshot: ${snapshot ? `${snapshot.alignmentScore ?? "unknown"}/100 — ${snapshot.evaluationSummary}` : "none"}\nActive cycle: ${cycle ? `${cycle.status} — ${cycle.proposal}` : "none"}\nCycle links: ${cycle?.githubPrUrl || "no PR yet"} | preview: ${cycle?.vercelPreviewUrl || "none"} | prod: ${cycle?.vercelProductionUrl || "none"}\nThread: ${cycle?.slackRootTs || "none"}\nRecent logs:\n${recentLogs.map((log) => `* ${log.createdAt.toISOString()} ${log.source}/${log.eventType}`).join("\n") || "* none"}`;
}

async function startAutonomousCycleText(options: HandlerOptions = {}): Promise<string> {
  if (options.threadTs) await postToGeneral("[AutoApp] Start received. I’ll keep every update in this thread.", options.threadTs);
  const result = await runObservationCycle({ post: true, threadTs: options.threadTs });
  if (result.status === "active_cycle_exists") return `I already have an active OODA cycle (${result.cycle.status}). I’ll keep watching the Cursor cloud agent and GitHub PR state. Use \`@autoapp abort\` if you want to discard it and start fresh.`;
  if (result.status === "no_mission") return "I need a mission first. Say `@autoapp start <what to build>` or `/autoapp set-mission <mission>`.";
  if (result.status === "paused") return "The mission is paused. Use `@autoapp resume` when you want me to continue, or `@autoapp abort` to start fresh.";
  if (options.threadTs) await postToGeneral("[AutoApp] Proposal recorded. Launching a Cursor cloud agent to implement now...", options.threadTs);
  await autonomouslyApproveAndRequestAgent(result.cycle.id);
  await logAutoappEvent("cycle_started", { cycleId: result.cycle.id, threadTs: options.threadTs, sourceTs: options.sourceTs });
  return "Started an autonomous OODA cycle: observed the app, oriented around the mission, decided on the next small change, and launched a Cursor cloud agent to implement it. I’ll stream follow-up logs in this thread, watch the PR through GitHub, and merge it through the GitHub API when ready.";
}

async function startQuickChangeCycleText(request: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  if (options.threadTs) await postToGeneral("[AutoApp] Quick code-change request received. I’ll keep updates in this thread and leave the mission unchanged.", options.threadTs);
  const result = await requestQuickChangeAgent(request, userId, options.sourceTs, options.threadTs);
  if (result.status === "active_cycle_exists") return `I already have an active implementation cycle (${result.cycle.status}). I did not change the mission. Use \`@autoapp abort\` if you want to discard it before starting this quick change.`;
  if (result.status === "no_mission") return "I can launch quick code changes once there is an active mission to attach the cycle to. Set one with `@autoapp start <mission>` or `/autoapp set-mission <mission>`.";
  await logAutoappEvent("quick_change_started", { cycleId: result.cycle.id, request, threadTs: options.threadTs, sourceTs: options.sourceTs });
  return "Got it — I treated that as a quick code change, left the active mission unchanged, and launched a Cursor cloud agent to implement it. I’ll watch the PR and stream progress in this thread.";
}

function stripAutoappMention(text: string) {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
}

async function incorporateGuidanceAndMaybeStart(text: string): Promise<string> {
  const guidance = stripAutoappMention(text);
  if (!guidance) return HELP_TEXT;
  const mission = await incorporateMissionInput(guidance);
  await logAutoappEvent("mission_guidance_added", { missionId: mission.id, guidance });
  const activeCycle = await getActiveCycle();
  if (activeCycle) return `Got it — I folded that into the mission guidance for “${mission.title}” and will use it in the current cycle. Active cycle: ${activeCycle.status}.`;
  return `Got it — I folded that into the mission guidance for “${mission.title}”. Say \`@autoapp start\` when you want me to run the next OODA cycle.`;
}

export async function handleMention(text: string, userId: string, options: HandlerOptions = {}) {
  const cleaned = stripAutoappMention(text);
  let intent;
  try {
    intent = await classifySlackMentionIntent(cleaned);
  } catch (error) {
    if (error instanceof SlackIntentUnavailableError) return `[Unavailable] ${error.message}`;
    throw error;
  }

  if (intent.confidence < 0.55 || intent.kind === "unknown") return "I could not confidently classify that Slack request. No Cursor agent was started and the mission was not changed.";
  if (intent.kind === "code_change") return startQuickChangeCycleText(intent.request, userId, options);
  if (intent.kind === "question") return answerGeneralQuestion(intent.request);
  if (intent.kind === "mission_update") {
    if (options.threadTs) await postToGeneral(`[AutoApp] Setting a fresh active mission: ${intent.request}`, options.threadTs);
    await setActiveMission(intent.request);
    await logAutoappEvent("mission_set", { title: intent.request, source: "mention", threadTs: options.threadTs });
    return startAutonomousCycleText(options);
  }

  return handleClassifiedControl(intent.controlAction || "none", userId, options);
}

async function handleClassifiedControl(action: string, userId: string, options: HandlerOptions): Promise<string> {
  switch (action) {
    case "help":
      return HELP_TEXT;
    case "status":
      return getStatusText();
    case "mission": {
      const mission = await getActiveMission();
      return mission ? `Current mission: ${mission.title}\nStatus: ${mission.status}\nGuidance:\n${mission.description}` : "No active mission. Use `/autoapp set-mission <mission>` or ask AutoApp to set a mission in Slack.";
    }
    case "start":
      return startAutonomousCycleText(options);
    case "pause":
      return handleAutoappCommand("pause");
    case "resume":
      return handleAutoappCommand("resume");
    case "abort":
      return abortMissionText(userId, options.sourceTs, options.threadTs);
    case "summarize":
      return summarizeLatestCycle();
    case "approve": {
      const cycle = await getActiveCycle();
      if (!cycle || cycle.status !== "proposed") return "No proposed cycle is waiting for approval. I’m already allowed to start and merge safe OODA-loop changes autonomously.";
      await approveAndRequestAgent(cycle.id, userId, options.sourceTs);
      await logAutoappEvent("cycle_approved", { cycleId: cycle.id, userId, threadTs: options.threadTs });
      return "Approval recorded. I launched a Cursor cloud agent to implement it; I will watch the resulting PR through GitHub and stream progress in this thread.";
    }
    case "reject": {
      const cycle = await getActiveCycle();
      if (!cycle) return "No active cycle to reject.";
      await rejectCycle(cycle.id, userId, options.sourceTs);
      await logAutoappEvent("cycle_rejected", { cycleId: cycle.id, userId, threadTs: options.threadTs });
      return "Rejection recorded. I will not launch a cloud agent to implement that proposal. Use `@autoapp start` for another cycle or `@autoapp abort` to clear the mission.";
    }
    default:
      return "The LLM classified this as a control request but did not provide a supported action. No Cursor agent was started and the mission was not changed.";
  }
}

async function abortMissionText(userId: string, slackMessageTs?: string, threadTs?: string): Promise<string> {
  if (threadTs) await postToGeneral("[AutoApp] Abort received. Marking the active cycle rejected and archiving the active mission so the next `start` begins fresh...", threadTs);
  const result = await abortActiveMission(userId, slackMessageTs);
  await logAutoappEvent("mission_aborted", { missionId: result.mission?.id, abortedCycles: result.abortedCycles, userId, threadTs });
  return result.mission
    ? `[Control]\nAborted mission “${result.mission.title}” and cleared ${result.abortedCycles} active cycle(s). Say \`@autoapp start <new mission>\` to begin fresh.`
    : "[Control]\nNo active mission was running. Say `@autoapp start <new mission>` to begin fresh.";
}

export async function recordSlackMessage(event: { text?: string; user?: string; bot_id?: string; channel?: string; ts?: string; thread_ts?: string }) {
  const active = await getActiveCycle();
  const classified = classifySlackMessage({ text: event.text || "", authorId: event.user, botId: event.bot_id, channelId: event.channel, ts: event.ts, recentCycleId: active?.id });
  if (!event.channel || !event.ts) return classified;
  const memory = await prisma.slackMemory.upsert({
    where: { channelId_messageTs: { channelId: event.channel, messageTs: event.ts } },
    update: {},
    create: { channelId: event.channel, messageTs: event.ts, threadTs: event.thread_ts, authorId: event.user || event.bot_id || "unknown", authorType: classified.authorType, rawText: event.text || "", normalizedText: (event.text || "").replace(/\s+/g, " ").trim(), classification: classified.classification, importance: classified.importance, relatedCycleId: classified.relatedCycleId || undefined, extractedPrUrl: classified.extractedPrUrl, extractedDeploymentUrl: classified.extractedDeploymentUrl, extractedCycleCode: classified.extractedCycleCode },
  });
  const tool = parseToolUpdate(event.text || "");
  if (tool.source !== "unknown") {
    await prisma.integrationEvent.create({ data: { source: tool.source, eventType: tool.eventType, payload: toJsonPayload(tool), relatedCycleId: active?.id } });
    if (active) await updateCycleFromTool(active.id, tool);
  }
  return { ...classified, memory };
}

async function updateCycleFromTool(cycleId: string, tool: ReturnType<typeof parseToolUpdate>) {
  const data: Record<string, string | undefined> = {};
  if (tool.prUrl) data.githubPrUrl = tool.prUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("preview")) data.vercelPreviewUrl = tool.deploymentUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("production")) data.vercelProductionUrl = tool.deploymentUrl;
  const statusMap: Record<string, string> = { pr_opened: "pr_opened", pr_updated: "pr_opened", run_failed: "failed", checks_started: "waiting_for_checks", checks_passed: "waiting_for_preview_deploy", checks_failed: "failed", pr_merged: "waiting_for_production_deploy", preview_deployment_started: "waiting_for_preview_deploy", preview_deployment_ready: "preview_deployed", preview_deployment_failed: "failed", production_deployment_started: "waiting_for_production_deploy", production_deployment_ready: "completed", production_deployment_failed: "failed" };
  if (statusMap[tool.eventType]) data.status = statusMap[tool.eventType];
  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
  await logAutoappEvent("tool_update", { cycleId, tool });
  const cycle = await prisma.cycle.findUnique({ where: { id: cycleId } });
  const threadTs = cycle?.slackRootTs || undefined;
  await postToGeneral(`[${tool.source}] ${tool.eventType}${tool.prUrl ? ` — ${tool.prUrl}` : ""}${tool.deploymentUrl ? ` — ${tool.deploymentUrl}` : ""}`, threadTs);
  if (["pr_opened", "pr_updated", "run_finished", "checks_passed", "preview_deployment_ready"].includes(tool.eventType)) await requestAutonomousMergeIfReady(cycleId);
  if (tool.eventType === "production_deployment_ready") await completeCycle(cycleId, "Production deployment is ready after the autonomous PR merge.");
}

async function logAutoappEvent(eventType: string, payload: Record<string, unknown>) {
  await prisma.integrationEvent.create({ data: { source: "autoapp", eventType, payload: toJsonPayload(payload) } });
}

function toJsonPayload(payload: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonObject;
}
