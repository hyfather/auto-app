import { getOpenAIClient } from "@/lib/ai/openai";

export type SlackControlAction = "help" | "status" | "mission" | "start" | "pause" | "resume" | "abort" | "summarize" | "approve" | "reject" | "queue" | "cancel" | "prs" | "deployments" | "none";

export type SlackMentionIntent = {
  kind: "code_change" | "question" | "mission_update" | "control" | "unknown";
  confidence: number;
  request: string;
  controlAction?: SlackControlAction;
};

export class SlackIntentUnavailableError extends Error {
  constructor(message = "AutoApp is unavailable because the Slack intent LLM is not configured or did not return a usable response.") {
    super(message);
    this.name = "SlackIntentUnavailableError";
  }
}

export async function classifySlackMentionIntent(text: string): Promise<SlackMentionIntent> {
  const request = normalizeMentionText(text);
  const client = getOpenAIClient();
  if (!client) throw new SlackIntentUnavailableError("AutoApp is unavailable because OPENAI_API_KEY is not configured for Slack intent routing.");

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_SLACK_INTENT_MODEL?.trim() || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "Classify a Slack message sent to AutoApp.",
            "Return only JSON with keys: kind, confidence, request, controlAction.",
            "kind must be one of: code_change, question, mission_update, control, unknown.",
            "controlAction must be one of: help, status, mission, start, pause, resume, abort, summarize, approve, reject, queue, cancel, prs, deployments, none.",
            "Use control with controlAction=queue when the user wants to list/see current tasks, the queue, or what AutoApp is working on.",
            "Use control with controlAction=cancel when the user wants to cancel/stop/kill a specific queued task (e.g. mentions an AUTO-XXXXXX code or a task number); keep that code/number in request.",
            "Use control with controlAction=prs when the user wants to see GitHub pull requests / PRs and their state; if they mention open/closed/all, keep that word in request.",
            "Use control with controlAction=deployments when the user asks about deployments, the last/latest deploy, or when something was last deployed.",
            "Use code_change when the user asks AutoApp to implement or modify app/code/UI/config behavior.",
            "Use question for general knowledge or conversational questions that should be answered in Slack without starting a Cursor agent.",
            "Use mission_update only when the user wants to set or replace AutoApp's active mission; put the mission text in request.",
            "Use control for AutoApp control-plane commands and set controlAction accordingly.",
            "For code_change and question, keep request as the cleaned user request.",
          ].join(" "),
        },
        { role: "user", content: request },
      ],
      temperature: 0,
      max_tokens: 160,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    if (!isValidIntentKind(parsed.kind)) throw new SlackIntentUnavailableError("Slack intent LLM returned an invalid kind.");

    return {
      kind: parsed.kind,
      confidence: clampConfidence(parsed.confidence),
      request: typeof parsed.request === "string" && parsed.request.trim() ? parsed.request.trim() : request,
      controlAction: isValidControlAction(parsed.controlAction) ? parsed.controlAction : "none",
    };
  } catch (error) {
    if (error instanceof SlackIntentUnavailableError) throw error;
    throw new SlackIntentUnavailableError();
  }
}

export async function answerGeneralQuestion(question: string): Promise<string> {
  const cleaned = normalizeMentionText(question);
  const client = getOpenAIClient();
  if (!client) throw new SlackIntentUnavailableError("AutoApp is unavailable because OPENAI_API_KEY is not configured for Slack question answering.");

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
    const answer = response.choices[0]?.message?.content?.trim();
    if (!answer) throw new SlackIntentUnavailableError("Slack answer LLM returned an empty response.");
    return `${answer}\n\nNo Cursor agent was started.`;
  } catch (error) {
    if (error instanceof SlackIntentUnavailableError) throw error;
    throw new SlackIntentUnavailableError("AutoApp is unavailable because Slack question answering failed.");
  }
}

function normalizeMentionText(text: string): string {
  return text.replace(/<@[^>]+>/g, "").replace(/@autoapp/gi, "").replace(/\s+/g, " ").trim();
}

function isValidIntentKind(kind: unknown): kind is SlackMentionIntent["kind"] {
  return kind === "code_change" || kind === "question" || kind === "mission_update" || kind === "control" || kind === "unknown";
}

function isValidControlAction(action: unknown): action is SlackControlAction {
  return action === "help" || action === "status" || action === "mission" || action === "start" || action === "pause" || action === "resume" || action === "abort" || action === "summarize" || action === "approve" || action === "reject" || action === "queue" || action === "cancel" || action === "prs" || action === "deployments" || action === "none";
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}
