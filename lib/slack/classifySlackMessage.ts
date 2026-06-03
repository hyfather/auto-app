import { parseToolUpdate } from "./parseToolUpdate";

export type ClassificationInput = { text: string; authorId?: string; botId?: string; channelId?: string; ts?: string; recentTaskId?: string | null };
export type ClassificationOutput = {
  classification: "human_instruction" | "human_approval" | "human_rejection" | "cursor_update" | "github_update" | "vercel_update" | "autoapp_log" | "general_noise" | "unknown";
  authorType: "human" | "autoapp" | "cursor" | "github" | "vercel" | "unknown";
  importance: number;
  relatedTaskId?: string | null;
  extractedPrUrl?: string;
  extractedDeploymentUrl?: string;
  extractedTaskCode?: string;
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
  const taskCode = text.match(/AUTO-[A-Z0-9]{3,}/i)?.[0]?.toUpperCase();
  const tool = parseToolUpdate(text);
  const author = input.authorId || input.botId || "";

  if (process.env.AUTOAPP_BOT_USER_ID && author === process.env.AUTOAPP_BOT_USER_ID) return { classification: "autoapp_log", authorType: "autoapp", importance: 2, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode };
  if (process.env.CURSOR_BOT_USER_ID && author === process.env.CURSOR_BOT_USER_ID) return { classification: "cursor_update", authorType: "cursor", importance: 5, relatedTaskId: input.recentTaskId, extractedPrUrl: tool.prUrl, extractedTaskCode: taskCode, prStatus: tool.status };
  if (process.env.VERCEL_BOT_USER_ID && author === process.env.VERCEL_BOT_USER_ID) return { classification: "vercel_update", authorType: "vercel", importance: 5, relatedTaskId: input.recentTaskId, extractedDeploymentUrl: tool.deploymentUrl, extractedTaskCode: taskCode, deploymentStatus: tool.status };
  if (process.env.GITHUB_BOT_USER_ID && author === process.env.GITHUB_BOT_USER_ID) return { classification: "github_update", authorType: "github", importance: 5, relatedTaskId: input.recentTaskId, extractedPrUrl: tool.prUrl, extractedTaskCode: taskCode, prStatus: tool.status };

  if (tool.source === "cursor") return { classification: "cursor_update", authorType: "cursor", importance: 5, relatedTaskId: input.recentTaskId, extractedPrUrl: tool.prUrl, extractedTaskCode: taskCode, prStatus: tool.status };
  if (tool.source === "vercel") return { classification: "vercel_update", authorType: "vercel", importance: 5, relatedTaskId: input.recentTaskId, extractedDeploymentUrl: tool.deploymentUrl, extractedTaskCode: taskCode, deploymentStatus: tool.status };
  if (tool.source === "github") return { classification: "github_update", authorType: "github", importance: 5, relatedTaskId: input.recentTaskId, extractedPrUrl: tool.prUrl, extractedTaskCode: taskCode, prStatus: tool.status };

  if (mentionsAutoApp(text) && /approve|approved|\byes\b|proceed|go ahead/i.test(lower)) return { classification: "human_approval", authorType: "human", importance: 5, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode, approvalIntent: "approved" };
  if (mentionsAutoApp(text) && /reject|\bno\b|stop|cancel|do not/i.test(lower)) return { classification: "human_rejection", authorType: "human", importance: 5, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode, approvalIntent: "rejected" };
  if (mentionsAutoApp(text)) return { classification: "human_instruction", authorType: "human", importance: 4, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode };
  if (input.ts && /\?|start|begin|kick off|launch|run|improve|make|change|remember|also|actually|instead/i.test(lower)) return { classification: "human_instruction", authorType: "human", importance: 3, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode };
  return { classification: "general_noise", authorType: "unknown", importance: 0, relatedTaskId: input.recentTaskId, extractedTaskCode: taskCode };
}
