import type { Cycle, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findActiveCycleByReference, getActiveCycle, getActiveCycles, MAX_ACTIVE_CYCLES } from "@/lib/autoapp/cycle";
import { addGuidanceToCycle, approveAndRequestAgent, autonomouslyApproveAndRequestAgent, cancelCycle, completeCycle, rejectCycle, requestAutonomousMergeIfReady, requestQuickChangeAgent } from "@/lib/autoapp/execute";
import { abortActiveMission, getActiveMission, incorporateMissionInput, pauseMission, resumeLatestMission, setActiveMission } from "@/lib/autoapp/mission";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { summarizeLatestCycle } from "@/lib/autoapp/summarize";
import { formatCycleCode } from "@/lib/autoapp/policies";
import { classifySlackMessage } from "./classifySlackMessage";
import { answerGeneralQuestion, classifySlackMentionIntent, SlackIntentUnavailableError } from "./intent";
import { parseToolUpdate } from "./parseToolUpdate";
import { postToGeneral } from "./postMessage";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

const HELP_TEXT = [
  "*AutoApp controls*",
  `AutoApp can run up to ${MAX_ACTIVE_CYCLES} tasks in parallel. Ask for a focused code change like \`@autoapp make the landing page default to light mode\` and it queues a Cursor cloud agent without changing the mission.`,
  "",
  "*Manage the task queue (`/autoapp` slash command):*",
  "• `/autoapp queue` — list every queued/in-flight task with its `AUTO-XXXXXX` code, status, and PR link.",
  "• `/autoapp new <request>` — queue a new focused code change (alias: just type the request).",
  "• `/autoapp update <task> <new instructions>` — revise a queued task (`<task>` is its code or queue slot like `#2`).",
  "• `/autoapp cancel <task>` — cancel one queued task and stop its Cursor agent.",
  "• `/autoapp abort` — discard the whole mission and every active task to start fresh.",
  "",
  "*Other controls:* `/autoapp status`, `mission`, `set-mission <text>`, `start [mission]`, `pause`, `resume`, `summarize`, `help`.",
  "Mentions like `@autoapp queue`, `@autoapp cancel AUTO-AB12CD`, `@autoapp status`, and `@autoapp start <mission>` work too. Mention replies stay in the Slack thread and AutoApp streams OODA progress there.",
].join("\n");

type HandlerOptions = { threadTs?: string; sourceTs?: string };
type CycleListItem = Pick<Cycle, "id" | "status" | "proposal"> & { githubPrUrl?: string | null };

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
    case "queue":
    case "tasks":
    case "list":
    case "runs":
      return listActiveCyclesText();
    case "new":
    case "create":
    case "add":
      if (!arg) return "Tell me what to build, e.g. `/autoapp new add a pricing FAQ section`.";
      return startQuickChangeCycleText(arg, userId);
    case "cancel":
    case "stop":
    case "kill":
      return cancelCycleText(arg, userId);
    case "update":
    case "edit":
    case "revise":
      return updateCycleText(arg, userId);
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
      if (arg) return cancelCycleText(arg, userId);
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
  const cycles = await getActiveCycles();
  const snapshot = mission ? await prisma.webAppSnapshot.findFirst({ where: { missionId: mission.id }, orderBy: { createdAt: "desc" } }) : null;
  const recentLogs = await prisma.integrationEvent.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  const queue = cycles.length ? formatCycleList(cycles) : "* none";
  return `[Status]\nMission: ${mission?.title ? `"${mission.title}"` : "none"}\nMission status: ${mission?.status || "n/a"}\nLatest web app snapshot: ${snapshot ? `${snapshot.alignmentScore ?? "unknown"}/100 — ${snapshot.evaluationSummary}` : "none"}\nActive tasks (${cycles.length}/${MAX_ACTIVE_CYCLES}):\n${queue}\nRecent logs:\n${recentLogs.map((log) => `* ${log.createdAt.toISOString()} ${log.source}/${log.eventType}`).join("\n") || "* none"}`;
}

async function startAutonomousCycleText(options: HandlerOptions = {}): Promise<string> {
  if (options.threadTs) await postToGeneral("[AutoApp] Start received. I’ll keep every update in this thread.", options.threadTs);
  const result = await runObservationCycle({ post: true, threadTs: options.threadTs, maxActiveCycles: MAX_ACTIVE_CYCLES });
  if (result.status === "queue_full") return queueFullText(result.cycles, result.max);
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
  if (result.status === "queue_full") return queueFullText(result.cycles, result.max);
  if (result.status === "no_mission") return "I can launch quick code changes once there is an active mission to attach the cycle to. Set one with `@autoapp start <mission>` or `/autoapp set-mission <mission>`.";
  await logAutoappEvent("quick_change_started", { cycleId: result.cycle.id, request, threadTs: options.threadTs, sourceTs: options.sourceTs });
  const code = formatCycleCode(result.cycle.id);
  return `Got it — queued this as task ${code} (${result.queueDepth}/${MAX_ACTIVE_CYCLES} tasks in flight), left the active mission unchanged, and launched a Cursor cloud agent to implement it. Watch progress with \`/autoapp queue\`; cancel it with \`/autoapp cancel ${code}\`.`;
}

function queueFullText(cycles: CycleListItem[], max: number): string {
  return `I’m already running the maximum of ${max} tasks in parallel, so I queued nothing new. Cancel one to free a slot:\n${formatCycleList(cycles)}\nUse \`/autoapp cancel <task>\` to drop one, or \`/autoapp abort\` to clear everything.`;
}

function formatCycleList(cycles: CycleListItem[]): string {
  if (!cycles.length) return "* (no active tasks)";
  return cycles
    .map((cycle, index) => {
      const code = formatCycleCode(cycle.id);
      const proposal = cycle.proposal.length > 120 ? `${cycle.proposal.slice(0, 117)}...` : cycle.proposal;
      const pr = cycle.githubPrUrl ? ` — ${cycle.githubPrUrl}` : "";
      return `${index + 1}. ${code} [${cycle.status}] ${proposal}${pr}`;
    })
    .join("\n");
}

async function listActiveCyclesText(): Promise<string> {
  const cycles = await getActiveCycles();
  if (!cycles.length) return "No active tasks right now. Ask for a code change like `@autoapp add a pricing FAQ`, or run `/autoapp start` to begin an autonomous cycle.";
  return `[Queue]\n${cycles.length}/${MAX_ACTIVE_CYCLES} tasks in flight:\n${formatCycleList(cycles)}\nManage them with \`/autoapp update <task> <text>\` or \`/autoapp cancel <task>\`.`;
}

async function cancelCycleText(arg: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  const reference = arg.trim().split(/\s+/)[0] || "";
  if (!reference) return "Tell me which task to cancel, e.g. `/autoapp cancel AUTO-AB12CD` or `/autoapp cancel #2`. Run `/autoapp queue` to see the codes.";
  const cycle = await findActiveCycleByReference(reference);
  if (!cycle) return `No active task matches \`${reference}\`. Run \`/autoapp queue\` to see current task codes.`;
  const { agentStopped } = await cancelCycle(cycle.id, userId, options.sourceTs);
  await logAutoappEvent("cycle_cancelled", { cycleId: cycle.id, userId, agentStopped, threadTs: options.threadTs });
  const remaining = await getActiveCycles();
  return `Cancelled task ${formatCycleCode(cycle.id)}${agentStopped ? " and asked Cursor to stop its cloud agent" : ""}. ${remaining.length}/${MAX_ACTIVE_CYCLES} tasks still in flight.`;
}

async function updateCycleText(arg: string, userId: string, options: HandlerOptions = {}): Promise<string> {
  const trimmed = arg.trim();
  const [reference, ...rest] = trimmed.split(/\s+/);
  const guidance = rest.join(" ").trim();
  if (!reference || !guidance) return "Usage: `/autoapp update <task> <new instructions>`, e.g. `/autoapp update AUTO-AB12CD also keep the dark-mode toggle`. Run `/autoapp queue` for task codes.";
  const cycle = await findActiveCycleByReference(reference);
  if (!cycle) return `No active task matches \`${reference}\`. Run \`/autoapp queue\` to see current task codes.`;
  const { mode } = await addGuidanceToCycle(cycle.id, guidance, userId);
  await logAutoappEvent("cycle_updated", { cycleId: cycle.id, userId, mode, threadTs: options.threadTs });
  const code = formatCycleCode(cycle.id);
  if (mode === "rewrote_proposal") return `Updated task ${code} before it launched — it will use the new instructions.`;
  if (mode === "followup_run") return `Sent your update to the running Cursor cloud agent for task ${code}; it will fold the new instructions into the open PR.`;
  return `Recorded your update for task ${code}. I couldn’t reach a live agent to revise, so this is stored as guidance for the task.`;
}

function stripAutoappMention(text: string) {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
}

/**
 * Pull a task reference out of a freeform cancel request such as
 * "cancel AUTO-AB12CD", "stop task 2", or "kill #3". Falls back to the raw
 * trimmed text so findActiveCycleByReference can try its own matching.
 */
function extractCycleReference(request: string): string {
  const text = request.trim();
  const code = text.match(/AUTO-?[A-Z0-9]{3,}/i)?.[0];
  if (code) return code;
  const slot = text.match(/\b(?:task|run|number|no\.?|slot)\s*#?\s*(\d{1,2})\b/i);
  if (slot && slot[1]) return slot[1];
  const hashSlot = text.match(/#\s*(\d{1,2})/);
  if (hashSlot && hashSlot[1]) return hashSlot[1];
  const bareNumber = text.match(/^\s*(\d{1,2})\s*$/);
  if (bareNumber && bareNumber[1]) return bareNumber[1];
  return text;
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

  return handleClassifiedControl(intent.controlAction || "none", userId, options, intent.request);
}

async function handleClassifiedControl(action: string, userId: string, options: HandlerOptions, request = ""): Promise<string> {
  switch (action) {
    case "help":
      return HELP_TEXT;
    case "status":
      return getStatusText();
    case "queue":
      return listActiveCyclesText();
    case "cancel":
      return cancelCycleText(extractCycleReference(request), userId, options);
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
  const tool = parseToolUpdate(event.text || "");
  // With several cycles in flight, attribute a GitHub/Vercel/Cursor update to
  // the cycle it actually references (by PR URL, thread, or AUTO-XXXXXX code)
  // before falling back to the most recent active cycle.
  const target = await resolveCycleForUpdate(event.text || "", tool, event.thread_ts);
  const classified = classifySlackMessage({ text: event.text || "", authorId: event.user, botId: event.bot_id, channelId: event.channel, ts: event.ts, recentCycleId: target?.id });
  if (!event.channel || !event.ts) return classified;
  const memory = await prisma.slackMemory.upsert({
    where: { channelId_messageTs: { channelId: event.channel, messageTs: event.ts } },
    update: {},
    create: { channelId: event.channel, messageTs: event.ts, threadTs: event.thread_ts, authorId: event.user || event.bot_id || "unknown", authorType: classified.authorType, rawText: event.text || "", normalizedText: (event.text || "").replace(/\s+/g, " ").trim(), classification: classified.classification, importance: classified.importance, relatedCycleId: classified.relatedCycleId || undefined, extractedPrUrl: classified.extractedPrUrl, extractedDeploymentUrl: classified.extractedDeploymentUrl, extractedCycleCode: classified.extractedCycleCode },
  });
  if (tool.source !== "unknown") {
    await prisma.integrationEvent.create({ data: { source: tool.source, eventType: tool.eventType, payload: toJsonPayload(tool), relatedCycleId: target?.id } });
    if (target) await updateCycleFromTool(target.id, tool);
  }
  return { ...classified, memory };
}

/**
 * Pick which active cycle a passive Cursor/GitHub/Vercel Slack update belongs
 * to. Prefers an exact PR-URL match, then the AUTO-XXXXXX code in the text,
 * then the Slack thread root, and finally the most recent active cycle so
 * legacy single-cycle behavior is preserved when nothing more specific matches.
 */
async function resolveCycleForUpdate(text: string, tool: ReturnType<typeof parseToolUpdate>, threadTs?: string): Promise<{ id: string } | null> {
  const cycles = await getActiveCycles();
  if (!cycles.length) return null;

  if (tool.prUrl) {
    const byPr = cycles.find((cycle) => cycle.githubPrUrl === tool.prUrl);
    if (byPr) return byPr;
  }
  const code = text.match(/AUTO-?([A-Z0-9]{3,})/i)?.[1]?.toUpperCase();
  if (code) {
    const byCode = cycles.find((cycle) => cycle.id.slice(-6).toUpperCase() === code || cycle.id.toUpperCase().endsWith(code));
    if (byCode) return byCode;
  }
  if (threadTs) {
    const byThread = cycles.find((cycle) => cycle.slackRootTs === threadTs);
    if (byThread) return byThread;
  }
  return cycles[cycles.length - 1];
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
