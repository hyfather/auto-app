import { NextResponse } from "next/server";
import { after } from "next/server";
import { handleAutoappCommand } from "@/lib/slack/handlers";
import { nudgeActiveTasks } from "@/lib/autoapp/execute";
import { verifySlackRequest } from "@/lib/slack/verify";

// Only `help`/`controls` reply with a static string that fits inside Slack's 3s
// slash-command budget. Everything else is routed through the tool-calling
// agent (which may call the OpenAI API and/or launch a Cursor cloud agent), so
// it is acknowledged instantly and finished in the background, with the final
// reply delivered via response_url.
const SYNCHRONOUS_COMMANDS = new Set(["help", "controls"]);

// Read-only and management commands (status, queue, PRs, deployments, evaluate,
// summarize, cancel, update) produce a one-shot answer for the requester that is
// NOT streamed to #general. Their reply must be relayed back via response_url,
// otherwise it is computed and silently discarded. A plain build request instead
// streams its progress as a new #general thread, so for that flow we only send a
// quick ephemeral ack and skip a redundant second confirmation.
const RELAY_REPLY_COMMANDS = new Set([
  "status",
  "queue",
  "tasks",
  "list",
  "runs",
  "ls",
  "prs",
  "pr",
  "pulls",
  "pull",
  "deployments",
  "deployment",
  "deploys",
  "deploy",
  "vercel",
  "health",
  "evaluate",
  "evaluation",
  "inspect",
  "review",
  "summary",
  "summarize",
  "summarise",
  "cancel",
  "stop",
  "kill",
  "abort",
  "reset",
  "update",
  "revise",
  "edit",
]);

async function postToResponseUrl(responseUrl: string, text: string) {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch (error) {
    console.error("[Slack commands] Failed to post to response_url:", error instanceof Error ? error.message : error);
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifySlackRequest(req, rawBody)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const form = new URLSearchParams(rawBody);
  const text = (form.get("text") || "help").trim();
  const responseUrl = form.get("response_url") || undefined;
  const userId = form.get("user_id") || "unknown";
  const command = (text.split(/\s+/)[0] || "help").toLowerCase();

  // Every slash interaction also nudges any in-flight task forward (discover a
  // newly opened PR, watch checks, merge when ready) so the loop keeps moving
  // even between scheduled cron runs.
  after(async () => {
    await nudgeActiveTasks();
  });

  if (responseUrl && !SYNCHRONOUS_COMMANDS.has(command)) {
    const relayReply = RELAY_REPLY_COMMANDS.has(command);
    after(async () => {
      try {
        const response = await handleAutoappCommand(text, userId);
        // Read-only/management commands (status, queue, prs, cancel, …) produce
        // a reply that isn't streamed to #general, so relay it back to the
        // requester. A build request streams progress as its own #general
        // thread, so we drop its reply to avoid a redundant ephemeral.
        if (relayReply) await postToResponseUrl(responseUrl, response);
      } catch (error) {
        console.error("[Slack commands] Deferred command failed:", error instanceof Error ? error.message : error);
        await postToResponseUrl(responseUrl, "Something went wrong running that command. Check #general for any partial progress, then try again.");
      }
    });
    // Acknowledge immediately with an ephemeral confirmation. A bare empty 200
    // leaves the user with no feedback (and Slack can surface its own "didn't
    // work" error for a body-less response), which made the command feel broken.
    return NextResponse.json({
      response_type: "ephemeral",
      text: relayReply
        ? "On it — fetching that now."
        : "On it — starting that now. I'll open a thread in #general and stream progress there.",
    });
  }

  try {
    const response = await handleAutoappCommand(text, userId);
    return NextResponse.json({ response_type: "ephemeral", text: response });
  } catch (error) {
    console.error("[Slack commands] Command failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ response_type: "ephemeral", text: "Something went wrong handling that command. Please try again in a moment." });
  }
}
