import { prisma } from "@/lib/db";
import { getActiveCycle } from "@/lib/autoapp/cycle";
import { approveAndRequestCodex, autonomouslyApproveAndRequestCodex, completeCycle, rejectCycle, requestAutonomousMergeIfReady } from "@/lib/autoapp/execute";
import { getActiveMission, incorporateMissionInput, pauseMission, resumeLatestMission, setActiveMission } from "@/lib/autoapp/mission";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { summarizeLatestCycle } from "@/lib/autoapp/summarize";
import { classifySlackMessage } from "./classifySlackMessage";
import { parseToolUpdate } from "./parseToolUpdate";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

const conversationalPrefixes = /^(?:please\s+)?(?:start(?:\s+on)?|begin|kick off|launch|run)\s+(?:a\s+)?mission\s*:?:?\s*/i;

export async function handleAutoappCommand(text: string): Promise<string> {
  try {
    return await handleAutoappCommandUnsafe(text);
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

async function handleAutoappCommandUnsafe(text: string): Promise<string> {
  const trimmed = text.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch ((command || "help").toLowerCase()) {
    case "help":
      return "AutoApp commands: `/autoapp status`, `mission`, `set-mission <text>`, `start <mission text>`, `propose`, `pause`, `resume`, `summarize`. Mentions are conversational: `@autoapp status` replies in-thread, and mission guidance is folded into the active mission.";
    case "status":
      return getStatusText();
    case "mission": {
      const mission = await getActiveMission();
      return mission ? `Current mission: ${mission.title}\nStatus: ${mission.status}\nGuidance: ${mission.description}` : "No active mission. Use `/autoapp set-mission <mission>` or say `@autoapp start mission: <mission>`.";
    }
    case "set-mission": {
      const mission = await setActiveMission(arg);
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
      return "[Next step]\nAutoApp is paused. Slash commands and mentions still work.";
    case "resume": {
      const mission = await resumeLatestMission();
      return mission ? `AutoApp resumed mission: ${mission.title}` : "No paused mission found to resume.";
    }
    case "summarize":
      return summarizeLatestCycle();
    default:
      return incorporateGuidanceAndMaybeStart(trimmed);
  }
}

export async function getStatusText() {
  const mission = await getActiveMission();
  const cycle = await getActiveCycle();
  const snapshot = mission ? await prisma.webAppSnapshot.findFirst({ where: { missionId: mission.id }, orderBy: { createdAt: "desc" } }) : null;
  return `[Status]\nMission: ${mission?.title ? `"${mission.title}"` : "none"}\nMission status: ${mission?.status || "n/a"}\nLatest web app snapshot: ${snapshot ? `${snapshot.alignmentScore ?? "unknown"}/100 — ${snapshot.evaluationSummary}` : "none"}\nActive cycle: ${cycle ? `${cycle.status} — ${cycle.proposal}` : "none"}`;
}

async function startAutonomousCycleText(): Promise<string> {
  const result = await runObservationCycle({ post: true });
  if (result.status === "active_cycle_exists") return "I already have an active OODA cycle. I’ll keep watching its thread for Codex/GitHub/Vercel updates.";
  if (result.status === "no_mission") return "I need a mission first. Say `@autoapp start mission: <what to build>` or `/autoapp set-mission <mission>`.";
  if (result.status === "paused") return "The mission is paused. Use `/autoapp resume` when you want me to continue.";
  await autonomouslyApproveAndRequestCodex(result.cycle.id);
  return "Started an autonomous OODA cycle: observed the app, oriented around the mission, decided on the next small change, and asked Codex to implement it. I’ll stay plugged into the thread and request merge when it looks ready.";
}

function missionFromMention(text: string) {
  const cleaned = stripAutoappMention(text);
  return cleaned.match(/set (?:the )?mission to (.+)$/i)?.[1]?.trim()
    || cleaned.match(/^mission\s*:\s*(.+)$/i)?.[1]?.trim()
    || cleaned.match(conversationalPrefixes)?.input?.replace(conversationalPrefixes, "").trim();
}

function stripAutoappMention(text: string) {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").trim();
}

async function incorporateGuidanceAndMaybeStart(text: string): Promise<string> {
  const guidance = stripAutoappMention(text);
  if (!guidance) return "AutoApp commands: `/autoapp status`, `mission`, `set-mission <text>`, `start <mission text>`, `propose`, `pause`, `resume`, `summarize`.";
  const mission = await incorporateMissionInput(guidance);
  const activeCycle = await getActiveCycle();
  if (activeCycle) return `Got it — I folded that into the mission guidance for “${mission.title}” and will use it in the current cycle.`;
  return `Got it — I folded that into the mission guidance for “${mission.title}”. Say \`@autoapp start\` when you want me to run the next OODA cycle.`;
}

export async function handleMention(text: string, userId: string, ts?: string) {
  const lower = text.toLowerCase();
  const cleaned = stripAutoappMention(text);
  const mission = missionFromMention(text);
  if (mission) {
    await setActiveMission(mission);
    return startAutonomousCycleText();
  }
  if (/^status\b|\bstatus\b|working on|last deployment/.test(lower)) return getStatusText();
  if (/approve|approved|yes|proceed|go ahead/.test(lower)) {
    const cycle = await getActiveCycle();
    if (!cycle || cycle.status !== "proposed") return "No proposed cycle is waiting for approval. I’m already allowed to start and merge safe OODA-loop changes autonomously.";
    await approveAndRequestCodex(cycle.id, userId, ts);
    return "Approval recorded. Codex request posted in #general.";
  }
  if (/reject|\bno\b|stop|cancel|do not/.test(lower)) {
    const cycle = await getActiveCycle();
    if (!cycle) return "No active cycle to reject.";
    await rejectCycle(cycle.id, userId, ts);
    return "Rejection recorded. I will not ask Codex to implement that proposal.";
  }
  if (/\b(start|begin|kick off|launch|run)\b|propose|improve/.test(lower) && cleaned.length < 80) return startAutonomousCycleText();
  if (/pause/.test(lower)) return handleAutoappCommand("pause");
  if (/resume/.test(lower)) return handleAutoappCommand("resume");
  if (/summarize|summary/.test(lower)) return summarizeLatestCycle();
  if (/\?$/.test(cleaned)) return answerQuestion(cleaned);
  return incorporateGuidanceAndMaybeStart(cleaned);
}

async function answerQuestion(question: string): Promise<string> {
  const status = await getStatusText();
  if (/what|how|where|why|when|who|mission|cycle|deploy|pr|status/i.test(question)) return `${status}\n\nShort answer: I’m operating from Slack as the control plane. If you give me mission guidance here, I’ll fold it into the active mission; if you ask me to start, I’ll run an OODA cycle and coordinate Codex/GitHub/Vercel from the channel.`;
  return "I’m here. Ask for `status`, tell me how to adjust the mission, or say `start` and I’ll run the next OODA cycle.";
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
    await prisma.integrationEvent.create({ data: { source: tool.source, eventType: tool.eventType, payload: tool, relatedCycleId: active?.id } });
    if (active) await updateCycleFromTool(active.id, tool);
  }
  return { ...classified, memory };
}

async function updateCycleFromTool(cycleId: string, tool: ReturnType<typeof parseToolUpdate>) {
  const data: Record<string, string | undefined> = {};
  if (tool.prUrl) data.githubPrUrl = tool.prUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("preview")) data.vercelPreviewUrl = tool.deploymentUrl;
  if (tool.deploymentUrl && tool.eventType.startsWith("production")) data.vercelProductionUrl = tool.deploymentUrl;
  const statusMap: Record<string, string> = { codex_failed: "failed", pr_opened: "pr_opened", checks_started: "waiting_for_checks", checks_passed: "waiting_for_preview_deploy", checks_failed: "failed", pr_merged: "waiting_for_production_deploy", preview_deployment_started: "waiting_for_preview_deploy", preview_deployment_ready: "preview_deployed", preview_deployment_failed: "failed", production_deployment_started: "waiting_for_production_deploy", production_deployment_ready: "completed", production_deployment_failed: "failed" };
  if (statusMap[tool.eventType]) data.status = statusMap[tool.eventType];
  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
  if (["checks_passed", "preview_deployment_ready"].includes(tool.eventType)) await requestAutonomousMergeIfReady(cycleId);
  if (tool.eventType === "production_deployment_ready") await completeCycle(cycleId, "Production deployment is ready after the autonomous PR merge.");
}
