import type OpenAI from "openai";
import { getOpenAIClient } from "@/lib/ai/openai";
import { MAX_ACTIVE_TASKS } from "@/lib/autoapp/task";
import { HELP_TEXT } from "./help";
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools";

const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT = [
  "You are AutoApp, an autonomous app operator controlled from a single Slack channel.",
  "You turn user requests into code changes that are implemented by Cursor cloud agents; each such task opens a pull request that AutoApp watches and merges once GitHub checks pass.",
  `You run at most ${MAX_ACTIVE_TASKS} tasks in parallel — extra requests are turned away until a slot frees up.`,
  "Be agentic: think about what the user actually wants and use your tools to answer it. Spinning up a Cursor cloud agent is expensive, so only do it when the user genuinely wants code changed.",
  "NOT every request needs a Cursor agent. Many requests — especially questions about operational health, status, deployments, or pull requests — can be answered directly by gathering the right context with the read-only tools. Prefer answering with context over creating a task whenever the user is asking a question rather than requesting a change.",
  "Your tools fall into three groups:",
  "- Spin up a Cursor agent: create_task — only when the user asks you to build, add, change, fix, improve, or implement something in the app. Also: list_tasks, cancel_task, update_task, set_mission, get_mission to manage that work.",
  "- Get info from GitHub: get_status (overall operational health), list_pull_requests, get_deployments, and evaluate_app to review the live app.",
  "- Get info from Vercel: get_vercel_info for the latest Vercel deployments and their state.",
  "For an 'how is operational health?' style question, call get_status (and get_vercel_info if more Vercel detail is wanted) and summarize the result — do NOT create a task.",
  "Answer general questions directly without calling a tool. Never invent task codes, PR links, or statuses — rely on tool output.",
  "Keep replies concise and Slack-friendly. When a tool returns a message, relay its key information to the user.",
].join("\n");

/**
 * The tool-calling agent that backs the Slack `/autoapp` command and mentions.
 * When OpenAI is configured it runs a function-calling loop over the AutoApp
 * tool registry; otherwise it falls back to a deterministic keyword router that
 * calls the same tools, so AutoApp stays usable without an LLM key.
 */
export async function runAutoappAgent(message: string, ctx: ToolContext): Promise<string> {
  const text = message.trim();
  if (!text || /^(help|controls|commands)\b/i.test(text)) return HELP_TEXT;

  const client = getOpenAIClient();
  if (!client) return fallbackRoute(text, ctx);

  try {
    return await runWithOpenAI(client, text, ctx);
  } catch (error) {
    console.error("[AutoApp agent] OpenAI tool loop failed, falling back:", error instanceof Error ? error.message : error);
    return fallbackRoute(text, ctx);
  }
}

async function runWithOpenAI(client: OpenAI, text: string, ctx: ToolContext): Promise<string> {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Record<string, unknown> },
  }));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_AGENT_MODEL?.trim() || "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0,
    });
    const choice = response.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls || [];
    if (!toolCalls.length) {
      const content = choice.content?.trim();
      if (content) return content;
      break;
    }

    messages.push(choice);
    for (const call of toolCalls) {
      const result = await dispatchToolCall(call.function.name, call.function.arguments, ctx);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Tool loop exhausted without a natural-language wrap-up: surface the latest
  // tool output so the user still gets a useful reply.
  const lastTool = [...messages].reverse().find((m) => m.role === "tool");
  return (typeof lastTool?.content === "string" && lastTool.content) || "I wasn't able to complete that request. Try rephrasing it or run `/autoapp help`.";
}

async function dispatchToolCall(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) return `Unknown tool "${name}".`;
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return `I could not parse the arguments for ${name}.`;
  }
  try {
    return await tool.execute(args, ctx);
  } catch (error) {
    return `The ${name} tool failed: ${error instanceof Error ? error.message : "unknown error"}.`;
  }
}

function extractTaskReference(text: string): string {
  const code = text.match(/AUTO-?[A-Z0-9]{3,}/i)?.[0];
  if (code) return code;
  const slot = text.match(/\b(?:task|run|number|no\.?|slot)\s*#?\s*(\d{1,2})\b/i);
  if (slot?.[1]) return slot[1];
  const hashSlot = text.match(/#\s*(\d{1,2})/);
  if (hashSlot?.[1]) return hashSlot[1];
  return "";
}

/**
 * Deterministic keyword router used when OpenAI is not configured (or the tool
 * loop fails). It maps a message to a single tool call from the same registry
 * the LLM uses, defaulting to create_task so a plain request still launches a
 * Cursor cloud agent.
 */
export async function fallbackRoute(message: string, ctx: ToolContext): Promise<string> {
  const text = message.trim();
  const lower = text.toLowerCase();

  // The separate `mission` command manages AutoApp's overarching durable mission.
  const missionMatch = text.match(/^mission\b[:\s]*([\s\S]*)$/i);
  if (missionMatch) {
    const rest = missionMatch[1].trim();
    if (!rest || /^(show|view|status|current|get|what|\?)\b/i.test(rest)) return TOOLS_BY_NAME.get_mission.execute({}, ctx);
    if (/^(clear|reset|remove|delete|none|off|unset)\b/i.test(rest)) return TOOLS_BY_NAME.set_mission.execute({ mission: "" }, ctx);
    return TOOLS_BY_NAME.set_mission.execute({ mission: rest }, ctx);
  }

  if (/\b(cancel|stop|kill|abort|reset)\b/.test(lower)) {
    if (/\b(all|every|everything)\b/.test(lower) || /\b(abort|reset)\b/.test(lower)) {
      const ref = extractTaskReference(text);
      if (!ref) return TOOLS_BY_NAME.cancel_task.execute({ all: true }, ctx);
      return TOOLS_BY_NAME.cancel_task.execute({ task: ref }, ctx);
    }
    return TOOLS_BY_NAME.cancel_task.execute({ task: extractTaskReference(text) }, ctx);
  }

  if (/\b(update|revise|edit)\b/.test(lower)) {
    const stripped = text.replace(/^\s*(update|revise|edit)\s+/i, "");
    const ref = extractTaskReference(stripped);
    const instructions = ref ? stripped.replace(ref, "").replace(/^[#\s]+/, "").trim() : stripped;
    return TOOLS_BY_NAME.update_task.execute({ task: ref, instructions }, ctx);
  }

  if (/\b(queue|tasks|in flight|working on|what are you (doing|building))\b/.test(lower) || /^(list|runs)\b/.test(lower)) {
    return TOOLS_BY_NAME.list_tasks.execute({}, ctx);
  }
  // Operational-health / status questions are answered with context, not a task.
  if (/\bstatus\b/.test(lower) || /\b(operational |op )?health\b/.test(lower) || /\b(how('s| is| are)\b.*\b(things|everything|we|it|the app|going|doing))\b/.test(lower)) {
    return TOOLS_BY_NAME.get_status.execute({}, ctx);
  }
  if (/\bvercel\b/.test(lower)) {
    const target = /\bprod(uction)?\b/.test(lower) ? "production" : undefined;
    return TOOLS_BY_NAME.get_vercel_info.execute(target ? { target } : {}, ctx);
  }
  if (/\b(pull request|pull requests|prs?|pulls)\b/.test(lower)) {
    const state = /\bclosed\b/.test(lower) ? "closed" : /\b(all|merged)\b/.test(lower) ? "all" : "open";
    return TOOLS_BY_NAME.list_pull_requests.execute({ state }, ctx);
  }
  if (/\b(deploy|deploys|deployment|deployments)\b/.test(lower)) return TOOLS_BY_NAME.get_deployments.execute({}, ctx);
  if (/\b(evaluate|inspect|current state)\b/.test(lower) || /\breview (the )?(app|site|page|homepage)\b/.test(lower)) {
    return TOOLS_BY_NAME.evaluate_app.execute({}, ctx);
  }
  if (/\b(summari[sz]e|summary)\b/.test(lower)) return TOOLS_BY_NAME.summarize_task.execute({}, ctx);

  return TOOLS_BY_NAME.create_task.execute({ request: stripLeadingVerbNoise(text) }, ctx);
}

/** Drop a leading `new`/`create`/`add` keyword so `/autoapp new <x>` reads cleanly as the request. */
function stripLeadingVerbNoise(text: string): string {
  return text.replace(/^\s*(new|create|add task|task)\s+/i, "").trim() || text.trim();
}
