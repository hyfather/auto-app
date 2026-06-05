import { getSlackClient } from "./client";

/**
 * The three task-lifecycle reactions AutoApp manages on the Slack message that
 * kicked off a task: it adds :eyes: while work is in flight, then swaps to
 * :white_check_mark: once the change is implemented and merged, or :warning: if
 * the task did not succeed.
 */
export const TASK_REACTIONS = {
  inProgress: "eyes",
  success: "white_check_mark",
  failed: "warning",
} as const;

const ALL_TASK_REACTIONS = Object.values(TASK_REACTIONS);

/** Slack API errors that mean the reaction is already in the desired state. */
const BENIGN_REACTION_ERRORS = new Set(["already_reacted", "no_reaction"]);

function logReactionError(action: string, error: unknown): void {
  const code = (error as { data?: { error?: string } } | undefined)?.data?.error;
  if (code && BENIGN_REACTION_ERRORS.has(code)) return;
  console.error(`[Slack] Failed to ${action} reaction:`, error instanceof Error ? error.message : error);
}

/**
 * Pick the reaction that should be present for a given task status. In-flight
 * statuses get :eyes:, a completed task gets :white_check_mark:, a failed task
 * gets :warning:. Cancelled tasks clear the reaction (null) since they were
 * neither completed nor a failure.
 */
function reactionForStatus(status: string): string | null {
  if (status === "completed") return TASK_REACTIONS.success;
  if (status === "failed") return TASK_REACTIONS.failed;
  if (status === "cancelled") return null;
  return TASK_REACTIONS.inProgress;
}

/**
 * Reconcile the lifecycle reaction on a task's Slack message to match its
 * status. Removes the other managed reactions and adds the right one, so the
 * single message shows :eyes: → :white_check_mark: / :warning: as the task
 * progresses. Best-effort and never throws: a missing token/scope or Slack
 * failure is logged and swallowed so it can't break a control-plane handler.
 */
export async function syncTaskReaction(slackRootTs: string | null | undefined, status: string): Promise<void> {
  const channel = process.env.SLACK_GENERAL_CHANNEL_ID;
  const client = getSlackClient();
  if (!channel || !client || !slackRootTs) return;

  const target = reactionForStatus(status);

  for (const name of ALL_TASK_REACTIONS) {
    if (name === target) continue;
    try {
      await client.reactions.remove({ channel, timestamp: slackRootTs, name });
    } catch (error) {
      logReactionError("remove", error);
    }
  }

  if (!target) return;
  try {
    await client.reactions.add({ channel, timestamp: slackRootTs, name: target });
  } catch (error) {
    logReactionError("add", error);
  }
}

/**
 * Mark a mentioned message as "AutoApp is working on it" with :eyes:. Used when
 * a user @mentions AutoApp so they get immediate feedback before any task is
 * launched (or for a read-only request like status that never launches a task).
 */
export async function markMessageWorking(messageTs: string | null | undefined): Promise<void> {
  await syncTaskReaction(messageTs, "queued");
}

/** Slack-safe reaction name: lowercase, alphanumeric/underscore/plus/minus, no colons. */
function normalizeEmojiName(emoji: string): string {
  return emoji.trim().replace(/^:|:$/g, "").replace(/[^a-z0-9_+-]/gi, "").toLowerCase();
}

/**
 * Add an arbitrary emoji reaction to a message so AutoApp can "emote" — e.g.
 * 🎉 when a change ships, 🤔 while it thinks, 🙏 to acknowledge. Best-effort and
 * never throws: a missing token/scope or an unknown emoji is logged and
 * swallowed so it can't break a control-plane handler. Returns true when the
 * reaction was added (or already present), false otherwise.
 */
export async function addReaction(messageTs: string | null | undefined, emoji: string): Promise<boolean> {
  const channel = process.env.SLACK_GENERAL_CHANNEL_ID;
  const client = getSlackClient();
  const name = normalizeEmojiName(emoji || "");
  if (!channel || !client || !messageTs || !name) return false;
  try {
    await client.reactions.add({ channel, timestamp: messageTs, name });
    return true;
  } catch (error) {
    const code = (error as { data?: { error?: string } } | undefined)?.data?.error;
    if (code && BENIGN_REACTION_ERRORS.has(code)) return true;
    logReactionError("add custom", error);
    return false;
  }
}

/**
 * Close out a mention that did not hand off to a task lifecycle: swap :eyes: for
 * :white_check_mark: when AutoApp answered successfully, or :warning: when it
 * failed. Task-backed mentions are left alone — their reaction is reconciled by
 * the task lifecycle as the work progresses.
 */
export async function markMessageDone(messageTs: string | null | undefined, ok: boolean): Promise<void> {
  await syncTaskReaction(messageTs, ok ? "completed" : "failed");
}
