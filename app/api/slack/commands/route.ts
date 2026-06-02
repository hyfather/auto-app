import { NextResponse } from "next/server";
import { after } from "next/server";
import { handleAutoappCommand } from "@/lib/slack/handlers";
import { nudgeActiveCycles } from "@/lib/autoapp/execute";
import { verifySlackRequest } from "@/lib/slack/verify";

// Fast subcommands that only touch the database and reliably reply within
// Slack's 3s slash-command budget. Anything else — `start`, `propose`, and
// freeform code-change requests that classify intent and launch a Cursor cloud
// agent — is acknowledged instantly and finished in the background, with the
// final reply delivered via response_url.
const SYNCHRONOUS_COMMANDS = new Set([
  "help",
  "controls",
  "status",
  "prs",
  "pulls",
  "pull-requests",
  "pullrequests",
  "pr",
  "deployments",
  "deployment",
  "deploys",
  "deploy",
  "github",
  "gh",
  "mission",
  "set-mission",
  "pause",
  "resume",
  "abort",
  "reset",
  "fresh-start",
  "summarize",
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

  // Every slash interaction also nudges any in-flight cycle forward (discover a
  // newly opened PR, watch checks, merge when ready) so the loop keeps moving
  // even between scheduled cron runs.
  after(async () => {
    await nudgeActiveCycles();
  });

  if (responseUrl && !SYNCHRONOUS_COMMANDS.has(command)) {
    after(async () => {
      try {
        const response = await handleAutoappCommand(text, userId);
        await postToResponseUrl(responseUrl, response);
      } catch (error) {
        console.error("[Slack commands] Deferred command failed:", error instanceof Error ? error.message : error);
        await postToResponseUrl(responseUrl, "Something went wrong running that command. Check #general for any partial progress, then try again.");
      }
    });
    return NextResponse.json({ response_type: "ephemeral", text: "On it — running that now. I'll stream progress in #general and reply here when the cycle is set up." });
  }

  try {
    const response = await handleAutoappCommand(text, userId);
    return NextResponse.json({ response_type: "ephemeral", text: response });
  } catch (error) {
    console.error("[Slack commands] Command failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ response_type: "ephemeral", text: "Something went wrong handling that command. Please try again in a moment." });
  }
}
