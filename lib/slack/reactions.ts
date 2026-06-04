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
