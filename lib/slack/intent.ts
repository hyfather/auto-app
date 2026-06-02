import { getOpenAIClient } from "@/lib/ai/openai";

export type SlackMentionIntent =
  | { kind: "code_change"; confidence: number; request: string }
  | { kind: "question"; confidence: number; request: string }
  | { kind: "mission_update"; confidence: number; request: string }
  | { kind: "control"; confidence: number; request: string }
  | { kind: "unknown"; confidence: number; request: string };

const APP_TARGET_WORDS = /\b(app|site|website|page|landing|homepage|hero|cta|button|theme|mode|copy|text|style|color|layout|component|default|form|section|ui|ux)\b/i;
const CODE_CHANGE_WORDS = /\b(make|change|update|add|remove|fix|implement|ensure|default|switch|set|show|hide|rename|improve)\b/i;
const GENERAL_QUESTION_WORDS = /\b(weather|temperature|forecast|time|date|news|sports|stock|recipe|joke|capital of|who is|what is|what's|explain|define)\b/i;
const CONTROL_WORDS = /\b(status|help|controls|commands|abort|reset|pause|resume|summarize|summary|approve|approved|reject|start|begin|kick off|launch|run|propose)\b/i;
const MISSION_WORDS = /\b(set[- ]?mission|mission is|set the mission|mission:)\b/i;

export async function classifySlackMentionIntent(text: string): Promise<SlackMentionIntent> {
  const request = normalizeMentionText(text);
  const client = getOpenAIClient();
  if (!client) return deterministicSlackMentionIntent(request);

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_SLACK_INTENT_MODEL?.trim() || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "Classify a Slack message sent to AutoApp.",
            "Return only JSON with: kind, confidence, request.",
            "kind must be one of: code_change, question, mission_update, control, unknown.",
            "Use code_change only when the user asks AutoApp to implement or modify app/code/UI/config behavior.",
            "Use question for general knowledge or conversational questions that should be answered in Slack without starting a Cursor agent.",
            "Use mission_update when the user wants to set or alter AutoApp's mission.",
            "Use control for status/help/start/abort/approve/reject/pause/resume/summarize commands.",
          ].join(" "),
        },
        { role: "user", content: request },
      ],
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as Partial<SlackMentionIntent>;
    if (isValidIntentKind(parsed.kind)) {
      return {
        kind: parsed.kind,
        confidence: clampConfidence(parsed.confidence),
        request: typeof parsed.request === "string" && parsed.request.trim() ? parsed.request.trim() : request,
      } as SlackMentionIntent;
    }
  } catch {
    // Fall back to deterministic routing so Slack remains responsive without LLM access.
  }

  return deterministicSlackMentionIntent(request);
}

export async function answerGeneralQuestion(question: string): Promise<string> {
  const cleaned = normalizeMentionText(question);
  const client = getOpenAIClient();
  const fallback = "I can answer AutoApp control questions here, but I do not have live external data in this Slack handler. I did not start a Cursor agent.";
  if (!client) return fallback;

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_SLACK_ANSWER_MODEL?.trim() || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are AutoApp in Slack. Answer concise general questions without claiming live web/tool access. If the question needs live data, say you cannot fetch it here. Never start or imply starting a Cursor agent.",
        },
        { role: "user", content: cleaned },
      ],
      temperature: 0.2,
      max_tokens: 180,
    });
    return `${response.choices[0]?.message?.content?.trim() || fallback}\n\nNo Cursor agent was started.`;
  } catch {
    return fallback;
  }
}

export function deterministicSlackMentionIntent(text: string): SlackMentionIntent {
  const request = normalizeMentionText(text);
  const lower = request.toLowerCase();

  if (!request) return { kind: "unknown", confidence: 0.2, request };
  if (MISSION_WORDS.test(lower)) return { kind: "mission_update", confidence: 0.9, request };
  if (CODE_CHANGE_WORDS.test(lower) && APP_TARGET_WORDS.test(lower) && !GENERAL_QUESTION_WORDS.test(lower)) {
    return { kind: "code_change", confidence: 0.78, request };
  }
  if (CONTROL_WORDS.test(lower) && request.split(/\s+/).length <= 8) return { kind: "control", confidence: 0.85, request };
  if (/[?]$/.test(request) || GENERAL_QUESTION_WORDS.test(lower)) return { kind: "question", confidence: 0.75, request };
  return { kind: "unknown", confidence: 0.45, request };
}

function normalizeMentionText(text: string): string {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").replace(/\s+/g, " ").trim();
}

function isValidIntentKind(kind: unknown): kind is SlackMentionIntent["kind"] {
  return kind === "code_change" || kind === "question" || kind === "mission_update" || kind === "control" || kind === "unknown";
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}
