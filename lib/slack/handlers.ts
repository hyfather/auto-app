import { prisma } from "@/lib/db";
import { getActiveCycle } from "@/lib/autoapp/cycle";
import { approveAndRequestCodex, rejectCycle } from "@/lib/autoapp/execute";
import { getActiveMission, pauseMission, resumeLatestMission, setActiveMission } from "@/lib/autoapp/mission";
import { runObservationCycle } from "@/lib/autoapp/observe";
import { summarizeLatestCycle } from "@/lib/autoapp/summarize";
import { classifySlackMessage } from "./classifySlackMessage";
import { parseToolUpdate } from "./parseToolUpdate";
import { DATABASE_SCHEMA_SETUP_MESSAGE, isMissingDatabaseSchemaError } from "@/lib/prisma-errors";

export async function handleAutoappCommand(text: string) {
  try {
    return await handleAutoappCommandUnsafe(text);
  } catch (error) {
    if (isMissingDatabaseSchemaError(error)) return `[Database setup required]\n${DATABASE_SCHEMA_SETUP_MESSAGE}`;
    throw error;
  }
}

async function handleAutoappCommandUnsafe(text: string) {
  const trimmed = text.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch ((command || "help").toLowerCase()) {
    case "help":
      return "AutoApp commands: `/autoapp status`, `mission`, `set-mission <text>`, `propose`, `pause`, `resume`, `summarize`. Approval can be `@autoapp approve`.";
    case "status":
      return getStatusText();
    case "mission": {
      const mission = await getActiveMission();
      return mission ? `Current mission: ${mission.title}\nStatus: ${mission.status}` : "No active mission. Use `/autoapp set-mission <mission>`.";
    }
    case "set-mission": {
      const mission = await setActiveMission(arg);
      return `[Mission update]\nCurrent mission is now: ${mission.title}\nNext step: run /autoapp propose when ready.`;
    }
    case "propose": {
      const result = await runObservationCycle({ post: true });
      if (result.status === "active_cycle_exists") return "AutoApp already has one active cycle. Approve, reject, or complete it before proposing another.";
      if (result.status === "no_mission") return "No active mission. Use `/autoapp set-mission <mission>`.";
      return "Proposal posted to #general for human approval.";
    }
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
      return "Unknown command. Try `/autoapp help`.";
  }
}

export async function getStatusText() {
  const mission = await getActiveMission();
  const cycle = await getActiveCycle();
  const snapshot = mission ? await prisma.webAppSnapshot.findFirst({ where: { missionId: mission.id }, orderBy: { createdAt: "desc" } }) : null;
  return `[Status]\nMission: ${mission?.title || "none"}\nMission status: ${mission?.status || "n/a"}\nLatest web app snapshot: ${snapshot ? `${snapshot.alignmentScore ?? "unknown"}/100 — ${snapshot.evaluationSummary}` : "none"}\nActive cycle: ${cycle ? `${cycle.status} — ${cycle.proposal}` : "none"}`;
}

function missionFromMention(text: string) {
  return text.match(/set (?:the )?mission to (.+)$/i)?.[1]?.trim();
}

export async function handleMention(text: string, userId: string, ts?: string) {
  const lower = text.toLowerCase();
  const mission = missionFromMention(text);
  if (mission) return handleAutoappCommand(`set-mission ${mission}`);
  if (/approve|approved|yes|proceed|go ahead/.test(lower)) {
    const cycle = await getActiveCycle();
    if (!cycle || cycle.status !== "proposed") return "No proposed cycle is waiting for approval.";
    await approveAndRequestCodex(cycle.id, userId, ts);
    return "Approval recorded. Codex request posted in #general.";
  }
  if (/reject|\bno\b|stop|cancel|do not/.test(lower)) {
    const cycle = await getActiveCycle();
    if (!cycle) return "No active cycle to reject.";
    await rejectCycle(cycle.id, userId, ts);
    return "Rejection recorded. AutoApp will not ask Codex to implement that proposal.";
  }
  if (/status|working on|last deployment/.test(lower)) return getStatusText();
  if (/propose|improve/.test(lower)) return handleAutoappCommand("propose");
  if (/pause/.test(lower)) return handleAutoappCommand("pause");
  if (/resume/.test(lower)) return handleAutoappCommand("resume");
  if (/summarize|summary/.test(lower)) return summarizeLatestCycle();
  return handleAutoappCommand("help");
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
  const statusMap: Record<string, string> = { pr_opened: "pr_opened", checks_started: "waiting_for_checks", checks_passed: "waiting_for_preview_deploy", checks_failed: "failed", pr_merged: "waiting_for_production_deploy", preview_deployment_started: "waiting_for_preview_deploy", preview_deployment_ready: "preview_deployed", preview_deployment_failed: "failed", production_deployment_started: "waiting_for_production_deploy", production_deployment_ready: "production_deployed", production_deployment_failed: "failed" };
  if (statusMap[tool.eventType]) data.status = statusMap[tool.eventType];
  if (Object.keys(data).length) await prisma.cycle.update({ where: { id: cycleId }, data });
}
