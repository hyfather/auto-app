import type { Task } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  addGuidanceToTask,
  cancelTask,
  createTask,
} from "@/lib/autoapp/execute";
import { findActiveTaskByReference, getActiveTasks, MAX_ACTIVE_TASKS } from "@/lib/autoapp/task";
import { clearMission, getMission, setMission } from "@/lib/autoapp/mission";
import { summarizeLatestTask } from "@/lib/autoapp/summarize";
import { formatTaskCode } from "@/lib/autoapp/policies";
import { summarizeLastDeployment, summarizePullRequests, type PullRequestState } from "@/lib/github/overview";
import { summarizeVercelDeployments } from "@/lib/vercel/overview";
import { isVercelConfigured } from "@/lib/vercel/client";

export type ToolContext = { userId: string; threadTs?: string; sourceTs?: string };

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

// Bound GitHub enrichment so a status/PR reply never blows Slack's 3s
// slash-command budget when the API is slow.
const GITHUB_LOOKUP_TIMEOUT_MS = 2500;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function indentLines(text: string): string {
  return text.includes("\n") || text.startsWith("*") ? text : `* ${text}`;
}

export function formatTaskList(tasks: Array<Pick<Task, "id" | "status" | "request" | "githubPrUrl">>): string {
  if (!tasks.length) return "* (no active tasks)";
  return tasks
    .map((task, index) => {
      const code = formatTaskCode(task.id);
      const request = task.request.length > 120 ? `${task.request.slice(0, 117)}...` : task.request;
      const pr = task.githubPrUrl ? ` — ${task.githubPrUrl}` : "";
      return `${index + 1}. ${code} [${task.status}] ${request}${pr}`;
    })
    .join("\n");
}

function turnedAwayText(tasks: Task[], max: number): string {
  return `I'm already running the maximum of ${max} tasks in parallel, so I turned this one away. Cancel one to free a slot:\n${formatTaskList(tasks)}\nUse \`/autoapp cancel <task>\` to drop one.`;
}

export async function getStatusText(): Promise<string> {
  const tasks = await getActiveTasks();
  const recentLogs = await prisma.integrationEvent.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  const queue = tasks.length ? formatTaskList(tasks) : "* none";
  const [pullRequests, lastDeployment, vercel] = await Promise.all([
    summarizePullRequests({ state: "open", withChecks: true, limit: 10, timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS }),
    summarizeLastDeployment({ timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS }),
    isVercelConfigured() ? summarizeVercelDeployments({ limit: 3, timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS }) : Promise.resolve(""),
  ]);
  const vercelSection = vercel ? `\nVercel deployments:\n${indentLines(vercel)}` : "";
  return `[Status]\nActive tasks (${tasks.length}/${MAX_ACTIVE_TASKS}):\n${queue}\nOpen pull requests:\n${indentLines(pullRequests)}\nLast deployment: ${lastDeployment}${vercelSection}\nRecent logs:\n${recentLogs.map((log) => `* ${log.createdAt.toISOString()} ${log.source}/${log.eventType}`).join("\n") || "* none"}`;
}

function parsePullRequestState(arg: string): PullRequestState {
  const value = arg.trim().toLowerCase();
  if (value === "closed") return "closed";
  if (value === "all" || value === "merged") return "all";
  return "open";
}

/**
 * Strip markup so the evaluate_app tool can return a readable snapshot of the
 * live homepage. This is the first concrete "evaluation" tool: it reviews the
 * current state of the deployed app without scoring it against a mission.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Take the first sentence of a tool description for a compact capabilities list. */
function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}

/**
 * Render the agent's own tool registry as a readable list. This backs the
 * `list_tools` tool so AutoApp can answer "what tools do you have access to?"
 * straight from the live registry instead of a hand-maintained description.
 */
export function formatToolList(): string {
  const lines = TOOLS.map((tool) => `• \`${tool.name}\` — ${firstSentence(tool.description)}`);
  return `[Tools]\nI have access to ${TOOLS.length} tools:\n${lines.join("\n")}`;
}

/**
 * The tool registry the AutoApp agent can call. Each tool wraps an existing
 * task/GitHub action so the agent decides *which* action to take while the
 * underlying behavior stays deterministic and testable. New capabilities (for
 * example a richer evaluation tool) can be added here without touching the
 * agent loop.
 */
export const TOOLS: ToolDef[] = [
  {
    name: "create_task",
    description:
      "Create a new task and launch a Cursor cloud agent to implement a focused code/UI/config change in the app. Use this whenever the user asks AutoApp to build, change, fix, add, or improve something. AutoApp runs at most 5 tasks in parallel; extra requests are turned away.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The concrete change to implement, in the user's words." } },
      required: ["request"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const request = str(args.request);
      if (!request) return "Tell me what to build, e.g. `add a pricing FAQ section`.";
      const result = await createTask(request, ctx.userId, ctx.threadTs);
      if (result.status === "turned_away") return turnedAwayText(result.tasks, result.max);
      const code = formatTaskCode(result.task.id);
      return `Queued task ${code} (${result.activeCount}/${MAX_ACTIVE_TASKS} tasks running) and launched a Cursor cloud agent to implement it. Track it with \`/autoapp queue\`; cancel it with \`/autoapp cancel ${code}\`.`;
    },
  },
  {
    name: "list_tasks",
    description: "List every queued or in-flight task with its AUTO-XXXXXX code, status, and PR link. Use when the user asks what AutoApp is working on, to see the queue, or to list running tasks.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const tasks = await getActiveTasks();
      if (!tasks.length) return "No active tasks right now. Ask for a code change like `@autoapp add a pricing FAQ`.";
      return `[Tasks]\n${tasks.length}/${MAX_ACTIVE_TASKS} tasks in flight:\n${formatTaskList(tasks)}\nManage them with \`/autoapp update <task> <text>\` or \`/autoapp cancel <task>\`.`;
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a single queued/in-flight task and stop its Cursor cloud agent. Identify the task by its AUTO-XXXXXX code or queue slot like #2. Set all=true to cancel every active task.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "AUTO-XXXXXX code or queue slot (e.g. #2) of the task to cancel." },
        all: { type: "boolean", description: "Cancel all active tasks." },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (args.all === true) {
        const tasks = await getActiveTasks();
        if (!tasks.length) return "There are no active tasks to cancel.";
        for (const task of tasks) await cancelTask(task.id, ctx.userId, ctx.sourceTs);
        return `Cancelled all ${tasks.length} active task(s) and asked Cursor to stop their cloud agents.`;
      }
      const reference = str(args.task);
      if (!reference) return "Tell me which task to cancel, e.g. `cancel AUTO-AB12CD` or `cancel #2`. Run `/autoapp queue` to see the codes.";
      const task = await findActiveTaskByReference(reference);
      if (!task) return `No active task matches \`${reference}\`. Run \`/autoapp queue\` to see current task codes.`;
      const { agentStopped } = await cancelTask(task.id, ctx.userId, ctx.sourceTs);
      const remaining = await getActiveTasks();
      return `Cancelled task ${formatTaskCode(task.id)}${agentStopped ? " and asked Cursor to stop its cloud agent" : ""}. ${remaining.length}/${MAX_ACTIVE_TASKS} tasks still in flight.`;
    },
  },
  {
    name: "update_task",
    description: "Revise an existing task with new instructions. Before the task launches this rewrites it; after launch it sends a follow-up to the running Cursor cloud agent. Identify the task by its AUTO-XXXXXX code or queue slot like #2.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "AUTO-XXXXXX code or queue slot (e.g. #2) of the task to update." },
        instructions: { type: "string", description: "The new/updated instructions for the task." },
      },
      required: ["task", "instructions"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const reference = str(args.task);
      const instructions = str(args.instructions);
      if (!reference || !instructions) return "Usage: update a task by its code plus new instructions, e.g. `update AUTO-AB12CD also keep the dark-mode toggle`.";
      const task = await findActiveTaskByReference(reference);
      if (!task) return `No active task matches \`${reference}\`. Run \`/autoapp queue\` to see current task codes.`;
      const { mode } = await addGuidanceToTask(task.id, instructions, ctx.userId);
      const code = formatTaskCode(task.id);
      if (mode === "rewrote_request") return `Updated task ${code} before it launched — it will use the new instructions.`;
      if (mode === "followup_run") return `Sent your update to the running Cursor cloud agent for task ${code}; it will fold the new instructions into the open PR.`;
      return `Recorded your update for task ${code}. I couldn't reach a live agent to revise, so this is stored as guidance for the task.`;
    },
  },
  {
    name: "get_status",
    description:
      "Get an overall operational-health snapshot by gathering context from GitHub and Vercel: the active task queue (N/5), open pull requests with their checks, the last deployment, recent Vercel deployment health, and recent activity logs. Use this to answer 'how is operational health?'-style questions directly, without creating a task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => getStatusText(),
  },
  {
    name: "list_pull_requests",
    description: "List GitHub pull requests with their current state (open/draft/merged/closed) and combined CI check result. Use when the user asks about PRs.",
    parameters: {
      type: "object",
      properties: { state: { type: "string", description: "Which PRs to list.", enum: ["open", "closed", "all"] } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const state = parsePullRequestState(str(args.state));
      const body = await summarizePullRequests({ state, withChecks: true, limit: 20, timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS });
      return `[Pull requests${state === "open" ? "" : ` · ${state}`}]\n${body}`;
    },
  },
  {
    name: "get_deployments",
    description: "Get GitHub deployment info: when the app was last deployed and the deployment state. Use when the user asks about deployments from GitHub.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const body = await summarizeLastDeployment({ timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS });
      return `[Deployment]\nLast deployment: ${body}`;
    },
  },
  {
    name: "get_vercel_info",
    description:
      "Get info from Vercel: the latest deployments and their state (READY / ERROR / BUILDING / …). Use this to answer deployment or operational-health questions about the live app directly, instead of creating a task. Set target to 'production' to limit to production deployments.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "Optional deployment target to filter by, e.g. 'production'." } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const target = str(args.target).toLowerCase() || undefined;
      const body = await summarizeVercelDeployments({ limit: 5, target, timeoutMs: GITHUB_LOOKUP_TIMEOUT_MS });
      return `[Vercel${target ? ` · ${target}` : ""}]\n${body}`;
    },
  },
  {
    name: "evaluate_app",
    description: "Review the current state of the live deployed web app by fetching its homepage and returning the HTTP status, title, and a snippet of visible text. Use when the user asks AutoApp to look at, inspect, or evaluate the current app.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const url = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      try {
        const response = await fetch(url, { cache: "no-store" });
        const html = await response.text();
        const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
        const text = stripHtml(html).slice(0, 600);
        return `[App review]\nFetched ${url} (HTTP ${response.status}).\nTitle: ${title || "unknown"}\nVisible text (start): ${text || "(none extracted)"}`;
      } catch (error) {
        return `[App review]\nCould not reach ${url}: ${error instanceof Error ? error.message : "unknown error"}.`;
      }
    },
  },
  {
    name: "summarize_task",
    description: "Summarize the most recent task: its status, request, PR, and related Slack updates.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => summarizeLatestTask(),
  },
  {
    name: "set_mission",
    description:
      "Set, update, or clear AutoApp's overarching durable mission — a standing objective folded into the prompt of every new Cursor cloud agent task alongside the specific request. Use when the user sets/changes/clears the mission (e.g. `mission keep the app fast and accessible`). Pass an empty mission to clear it.",
    parameters: {
      type: "object",
      properties: { mission: { type: "string", description: "The overarching mission text. Pass an empty string to clear the mission." } },
      required: ["mission"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const mission = str(args.mission);
      if (!mission) {
        await clearMission(ctx.userId);
        return "Cleared AutoApp's mission. New tasks will no longer carry mission context.";
      }
      await setMission(mission, ctx.userId);
      return `Set AutoApp's mission. Every new task will include it alongside the specific request:\n> ${mission}`;
    },
  },
  {
    name: "get_mission",
    description: "Show AutoApp's current overarching durable mission, if one is set.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const mission = await getMission();
      return mission ? `[Mission]\n${mission}` : "No mission is set. Set one with `/autoapp mission <text>` so every new task carries it.";
    },
  },
  {
    name: "list_tools",
    description: "List the tools (capabilities) the AutoApp agent itself can use, each with a one-line summary. Use when the user asks what tools you have access to, what you can do, or what your capabilities are.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => formatToolList(),
  },
];

export const TOOLS_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));
