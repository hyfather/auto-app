import { parseToolUpdate } from "./parseToolUpdate";

export type ClassificationInput = { text: string; authorId?: string; botId?: string; channelId?: string; ts?: string; recentCycleId?: string | null };
export type ClassificationOutput = {
  classification: "human_instruction" | "human_approval" | "human_rejection" | "codex_update" | "github_update" | "vercel_update" | "autoapp_log" | "mission_update" | "general_noise" | "unknown";
  authorType: "human" | "autoapp" | "codex" | "github" | "vercel" | "unknown";
  importance: number;
  relatedCycleId?: string | null;
  extractedPrUrl?: string;
  extractedDeploymentUrl?: string;
  extractedCycleCode?: string;
  approvalIntent?: "approved" | "rejected";
  deploymentStatus?: string;
  prStatus?: string;
};

function mentionsAutoApp(text: string) {
  const id = process.env.AUTOAPP_BOT_USER_ID;
  return /@autoapp|\/autoapp/i.test(text) || Boolean(id && text.includes(id));
}

export function classifySlackMessage(input: ClassificationInput): ClassificationOutput {
  const text = input.text || "";
  const lower = text.toLowerCase();
  const cycleCode = text.match(/AUTO-[A-Z0-9]{3,}/i)?.[0]?.toUpperCase();
  const tool = parseToolUpdate(text);
  const author = input.authorId || input.botId || "";

  if (process.env.AUTOAPP_BOT_USER_ID && author === process.env.AUTOAPP_BOT_USER_ID) return { classification: "autoapp_log", authorType: "autoapp", importance: 2, relatedCycleId: input.recentCycleId, extractedCycleCode: cycleCode };
  if (process.env.CODEX_BOT_USER_ID && author === process.env.CODEX_BOT_USER_ID) return { classification: "codex_update", authorType: "codex", importance: 5, relatedCycleId: input.recentCycleId, extractedPrUrl: tool.prUrl, extractedCycleCode: cycleCode, prStatus: tool.status };
  if (process.env.VERCEL_BOT_USER_ID && author === process.env.VERCEL_BOT_USER_ID) return { classification: "vercel_update", authorType: "vercel", importance: 5, relatedCycleId: input.recentCycleId, extractedDeploymentUrl: tool.deploymentUrl, extractedCycleCode: cycleCode, deploymentStatus: tool.status };
  if (process.env.GITHUB_BOT_USER_ID && author === process.env.GITHUB_BOT_USER_ID) return { classification: "github_update", authorType: "github", importance: 5, relatedCycleId: input.recentCycleId, extractedPrUrl: tool.prUrl, extractedCycleCode: cycleCode, prStatus: tool.status };

  if (tool.source === "codex") return { classification: "codex_update", authorType: "codex", importance: 5, relatedCycleId: input.recentCycleId, extractedPrUrl: tool.prUrl, extractedCycleCode: cycleCode, prStatus: tool.status };
  if (tool.source === "vercel") return { classification: "vercel_update", authorType: "vercel", importance: 5, relatedCycleId: input.recentCycleId, extractedDeploymentUrl: tool.deploymentUrl, extractedCycleCode: cycleCode, deploymentStatus: tool.status };
  if (tool.source === "github") return { classification: "github_update", authorType: "github", importance: 5, relatedCycleId: input.recentCycleId, extractedPrUrl: tool.prUrl, extractedCycleCode: cycleCode, prStatus: tool.status };

  if (mentionsAutoApp(text) && /approve|approved|\byes\b|proceed|go ahead/i.test(lower)) return { classification: "human_approval", authorType: "human", importance: 5, relatedCycleId: input.recentCycleId, extractedCycleCode: cycleCode, approvalIntent: "approved" };
  if (mentionsAutoApp(text) && /reject|\bno\b|stop|cancel|do not/i.test(lower)) return { classification: "human_rejection", authorType: "human", importance: 5, relatedCycleId: input.recentCycleId, extractedCycleCode: cycleCode, approvalIntent: "rejected" };
  if (/set[- ]mission|mission is|set the mission/i.test(lower)) return { classification: "mission_update", authorType: "human", importance: 5, relatedCycleId: input.recentCycleId };
  if (mentionsAutoApp(text)) return { classification: "human_instruction", authorType: "human", importance: 4, relatedCycleId: input.recentCycleId, extractedCycleCode: cycleCode };
  return { classification: "general_noise", authorType: "unknown", importance: 0, relatedCycleId: input.recentCycleId, extractedCycleCode: cycleCode };
}
