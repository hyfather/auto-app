import type OpenAI from "openai";
import { getOpenAIClient } from "@/lib/ai/openai";
import { MAX_ACTIVE_TASKS } from "@/lib/autoapp/task";
import type { ConversationTurn } from "@/lib/slack/threadHistory";
import { HELP_TEXT } from "./help";
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools";

const MAX_TOOL_ITERATIONS = 6;

/**
 * How the message reached AutoApp. A `command`/`mention` is an explicit address
 * to AutoApp, so an unmatched message defaults to creating a task. A `channel`
 * message is just someone talking in #general, so AutoApp chats back and only
 * creates a task when the intent is clearly a change request.
 */
export type AgentSource = "command" | "mention" | "channel";

/** Context for a single agent turn, including prior thread turns for continuity. */
export type AgentContext = ToolContext & { history?: ConversationTurn[]; source?: AgentSource };

const SYSTEM_PROMPT = [
  "You are AutoApp: a friendly, sharp engineering teammate who lives in one Slack channel and keeps the team's Vercel-hosted web app (a Next.js frontend) in great shape.",
  "You turn requests into code changes implemented by Cursor cloud agents; each task opens a pull request that AutoApp watches and merges once GitHub checks pass. The app auto-deploys to Vercel when a PR merges to main.",
  `You run at most ${MAX_ACTIVE_TASKS} tasks in parallel — extra requests are turned away until a slot frees up.`,
  "",
  "Conversation style — talk like a helpful teammate, not a form:",
  "- Be warm, concise, and natural. Open with a short friendly acknowledgement, then get to the point. Slack formatting only (no markdown headers).",
  "- The full thread is provided as conversation history; use it so follow-ups feel continuous and you never re-ask something already answered.",
  "- Ask a clarifying question when a change request is genuinely ambiguous, risky, or could be built several very different ways (e.g. unclear which page/section, vague visual intent, or missing copy). Ask at most ONE tight round of the few questions that actually matter, then proceed once you have enough to act. Don't interrogate; if the request is clear, just do it.",
  "- When you start a task, briefly say what you understood and that you'll stream progress in this thread.",
  "",
  "Reactions (reacji) are part of how you communicate:",
  "- You may call react_to_message to emote on the user's message — e.g. 'rocket' when you launch a task, 'thinking_face' when you ask a clarifying question, 'tada' when something ships, 'thumbsup'/'pray' to acknowledge. Use it alongside your text reply when it adds warmth; don't overuse it.",
  "- Users can also react to your messages to steer you: a ❌/🛑-style reaction on a task message cancels that task, and any reaction nudges in-flight work forward. Mention this naturally if it's helpful.",
  "",
  "Choosing what to do — be agentic and decisive:",
  "- Spinning up a Cursor cloud agent costs real money, so only create_task when the user genuinely wants the app built, changed, fixed, added to, improved, polished, or refactored. Lean toward small, focused frontend changes.",
  "- Many requests need NO task: questions about operational health, status, the queue, deployments, or pull requests are answered directly by gathering context with the read-only tools. Prefer answering with context over creating a task whenever the user is asking rather than requesting a change.",
  "- Manage work with list_tasks, cancel_task, update_task, set_mission, get_mission.",
  "- Read GitHub with get_status (overall health), list_pull_requests, get_deployments, and evaluate_app to inspect the live site.",
  "- Read Vercel with get_vercel_info for the latest deployments and their state.",
  "- Use list_tools when asked what you can do or what tools/capabilities you have, and report the result — never create a task for a question about your own capabilities.",
  "",
  "Always rely on tool output for facts; never invent task codes, PR links, statuses, or deployment results. Keep replies tight and Slack-friendly, and relay the key information a tool returns.",
].join("\n");

/**
 * The tool-calling agent that backs the Slack `/autoapp` command, mentions, and
 * plain channel messages. When OpenAI is configured it runs a function-calling
 * loop over the AutoApp tool registry with the thread's conversation history for
 * continuity; otherwise it falls back to a deterministic keyword router that
 * calls the same tools, so AutoApp stays usable without an LLM key.
 */
export async function runAutoappAgent(message: string, ctx: AgentContext): Promise<string> {
  const text = message.trim();
  if (!text || /^(help|controls|commands)\b/i.test(text)) return HELP_TEXT;
  // Meta questions about AutoApp's own capabilities are answered with the help
  // text, never by spinning up a Cursor cloud agent.
  if (isCapabilityQuestion(text)) return HELP_TEXT;

  const client = getOpenAIClient();
  if (!client) return fallbackRoute(text, ctx);

  try {
    return await runWithOpenAI(client, text, ctx);
  } catch (error) {
    console.error("[AutoApp agent] OpenAI tool loop failed, falling back:", error instanceof Error ? error.message : error);
    return fallbackRoute(text, ctx);
  }
}

async function runWithOpenAI(client: OpenAI, text: string, ctx: AgentContext): Promise<string> {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Record<string, unknown> },
  }));
  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = (ctx.history || [])
    .filter((turn) => turn.content.trim())
    .map((turn) => ({ role: turn.role, content: turn.content }));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
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

async function dispatchToolCall(name: string, rawArgs: string, ctx: AgentContext): Promise<string> {
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

/**
 * Detect questions about AutoApp's own capabilities (e.g. "what tools do you
 * have access to?", "what can you do?"). These are answered directly with the
 * help text rather than being routed to create_task and spinning up a Cursor
 * cloud agent.
 */
export function isCapabilityQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(what|which|list)\b[\s\S]*\b(tools?|capabilit(?:y|ies)|commands?|features?|abilities|functions?)\b/.test(lower)) {
    return true;
  }
  return /\bwhat\s+(can|do)\s+you\s+do\b/.test(lower) || /\bwhat\s+are\s+you\s+(able|capable)\b/.test(lower);
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
export async function fallbackRoute(message: string, ctx: AgentContext): Promise<string> {
  const text = message.trim();
  const lower = text.toLowerCase();

  // Capability/meta questions are answered with help, not a Cursor agent.
  if (isCapabilityQuestion(text)) return HELP_TEXT;

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

  // "What tools/capabilities do you have?" is answered from the registry, not a
  // task. Checked before list_tasks so "list your capabilities" isn't misread as
  // a queue request.
  if (
    /^(tools?|capabilities|abilities)\b/.test(lower) ||
    /\b(what|which|list)\b.{0,30}\b(tools?|capabilities|abilities)\b/.test(lower) ||
    /\b(what can you do|what do you do)\b/.test(lower)
  ) {
    return TOOLS_BY_NAME.list_tools.execute({}, ctx);
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

  // A plain channel message (someone just talking in #general, not a slash
  // command or @mention) only becomes a task when it clearly reads as a change
  // request. Otherwise AutoApp chats back instead of spending a Cursor agent on
  // small talk. Explicit `command`/`mention` sources keep defaulting to a task.
  if (ctx.source === "channel" && !looksLikeChangeRequest(lower)) {
    return CONVERSATIONAL_FALLBACK;
  }

  return TOOLS_BY_NAME.create_task.execute({ request: stripLeadingVerbNoise(text) }, ctx);
}

/**
 * Heuristic for whether a free-form channel message is asking for a code/UI
 * change (so the keyword fallback should launch a task) versus chit-chat.
 */
function looksLikeChangeRequest(lower: string): boolean {
  if (/\b(task|build|ship|implement)\b/.test(lower)) return true;
  return /\b(add|create|make|change|update|fix|improve|polish|tweak|adjust|redesign|restyle|style|remove|delete|rename|replace|move|hide|show|enable|disable|increase|decrease|swap|refactor|wire|integrate)\b/.test(
    lower,
  );
}

const CONVERSATIONAL_FALLBACK = [
  "Hey! I'm AutoApp — I keep the team's Vercel-hosted site in shape.",
  "Tell me what you'd like to change (e.g. \"make the hero headline say …\" or \"add a pricing FAQ\") and I'll start a task and stream progress here.",
  "You can also ask me things like `status`, `queue`, `list PRs`, or `deployments`. Type `help` for the full list.",
].join("\n");

/** Drop a leading `new`/`create`/`add` keyword so `/autoapp new <x>` reads cleanly as the request. */
function stripLeadingVerbNoise(text: string): string {
  return text.replace(/^\s*(new|create|add task|task)\s+/i, "").trim() || text.trim();
}
