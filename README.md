# AutoApp

AutoApp is a Slack-native autonomous app builder and operator. It has two facets:

- **Slack control plane:** AutoApp lives in one Slack channel, `#general`. Just **talk to it in the channel** — every top-level message gets an immediate, friendly reply in a thread from a **tool-calling agent** that asks clarifying questions, answers operational questions, and turns change requests into tasks that launch Cursor cloud agents. (`/autoapp` slash commands and `@autoapp` mentions still work too.) GitHub/Vercel updates also appear here.
- **Public Vercel web app:** the deployed web app at `/` is the product AutoApp ships changes to.

AutoApp intentionally does **not** include an `/admin` UI. Slack is the control plane.

There is no automatic web-app scoring. AutoApp only acts on **tasks** a human requests in Slack. You can optionally set one overarching, durable **mission** (`/autoapp mission <text>`) that is folded into the prompt of every new Cursor cloud agent task alongside the specific request.

## The tool-calling agent

The Slack backend is a tool-calling agent (`lib/agent`). When you message AutoApp, the agent decides which tool to call:

- `create_task` — launch a Cursor cloud agent to implement a focused change (this is how "invoking the Cursor agent" happens).
- `list_tasks`, `cancel_task`, `update_task`, `set_mission`, `get_mission`, `summarize_task` — manage the task queue and mission.
- `get_status`, `list_pull_requests`, `get_deployments`, `get_vercel_info` — read live state from GitHub and Vercel.
- `evaluate_app` — review the current state of the live app (fetches the homepage and returns status/title/text).
- `react_to_message` — add an emoji reaction to the user's message to emote (e.g. :rocket:, :tada:, :thinking_face:).
- `list_tools` — describe AutoApp's own capabilities.

When `OPENAI_API_KEY` is set, the agent runs an OpenAI function-calling loop (`OPENAI_AGENT_MODEL`, default `gpt-4o-mini`) with the full Slack thread as conversation history, so it can hold a natural multi-turn dialogue and ask clarifying questions. When it is not set, AutoApp falls back to a deterministic keyword router that calls the same tools (no clarifying questions, but commands and task creation still work), so the control plane keeps working without an LLM.

## Tasks and parallelism

AutoApp runs up to **5 tasks in parallel**. When 5 tasks are already in flight, a new request is **turned away** (not queued) until a slot frees up — cancel one with `/autoapp cancel <task>` to make room.

Each task:

1. Is created from your Slack request and immediately dispatched to a Cursor cloud agent with `autoCreatePR` enabled.
2. Gets a focused prompt: the task request plus do/don't guardrails and acceptance criteria, prefixed with the overarching mission when one is set.
3. Opens a pull request, which AutoApp watches through the GitHub REST API and merges once it is mergeable and checks are green.

A merged PR on `main` is AutoApp's success condition: once the change lands on the default branch the task is marked successful and the loop closes — whether AutoApp merged it through the API or GitHub native auto-merge did. AutoApp does **not** block waiting for a Vercel production-deploy signal.

## Integration model

- **Cursor Cloud Agents are the implementation worker.** AutoApp launches a [Cursor cloud agent](https://cursor.com/docs/cloud-agent/api/endpoints) through the Cursor API (`POST https://api.cursor.com/v1/agents`). The launch prompt also asks the agent to enable GitHub native auto-merge (`gh pr merge --auto`) so GitHub merges the PR once all required checks pass (configurable via `GITHUB_PR_AUTO_MERGE`).
- **GitHub is the code/change-management facet.** AutoApp polls the GitHub REST API for the PR link, state, checks, and mergeability, and merges directly through the API when ready.
- **Vercel is the deployment/runtime facet.** Deployment status is read from Vercel Slack notifications in `#general`; AutoApp does not call the Vercel API.
- **Slack is the control plane.** All activity flows through `SLACK_GENERAL_CHANNEL_ID`.

## Working log labels

AutoApp posts visible operational logs in Slack threads and never exposes private chain-of-thought. Logs use labels such as `Action`, `Waiting`, and `Result`. Control actions and tool updates are also stored as `IntegrationEvent` rows.

## Talking to AutoApp

AutoApp is conversational, like Cursor's own Slack integration: **add the bot to `#general` and just type.** You don't need a slash command or an `@mention`.

- **Every top-level message gets an immediate, friendly reply in a thread.** AutoApp reacts with :eyes: the moment it picks your message up, then answers in a thread hanging off your message and streams any task progress there.
- **It asks clarifying questions.** When a change request is ambiguous, risky, or could be built several ways, AutoApp asks one tight round of questions first. Answer in the thread and it continues — the whole thread is fed back to the agent so follow-ups read naturally (this multi-turn intelligence requires `OPENAI_API_KEY`; without it AutoApp uses a deterministic keyword router that still routes commands and starts tasks).
- **It focuses on upkeep of the Vercel-hosted frontend.** Describe a change and AutoApp launches a Cursor cloud agent to implement it, opens a PR, watches checks, and merges — which auto-deploys to Vercel.

Examples (just type these in `#general`):

```
make the hero headline say "Ship faster with AutoApp"
the pricing section feels cramped — add more vertical spacing
add a FAQ section to the landing page          → AutoApp may ask: which questions should it cover?
how is operational health?                      → answered from GitHub/Vercel, no task spun up
what are you working on?                         → lists the task queue
cancel AUTO-AB12CD                               → cancels that task
what can you do?                                 → lists AutoApp's tools/capabilities
```

### Reactions (reacji) — receive and emote

AutoApp uses emoji reactions as a two-way signal:

- **Emote:** AutoApp reacts with :eyes: while working, swaps it for :white_check_mark: on success or :warning: on failure, and the agent can add reactions like :rocket: (task launched) or :tada: (shipped) to make the interaction feel alive.
- **Receive:** react with :x:, :no_entry:, :octagonal_sign:, or :wastebasket: on a message tied to an active task (the request or any of its thread updates) and AutoApp **cancels that task** and stops its Cursor cloud agent. Adding *any* reaction also "wakes AutoApp up" — the `reaction_added` event advances every in-flight task on demand, which matters on Vercel's free plan where the scheduled cron (`/api/cron/poll`) only runs once a day.

### Slash commands and mentions (still supported)

Configure one `/autoapp` slash command pointed at `/api/slack/commands`. Everything except `help` is routed through the same tool-calling agent.

- `/autoapp new <request>` (or just the request) — queue a task and launch a Cursor cloud agent.
- `/autoapp queue` — list every queued/in-flight task with its `AUTO-XXXXXX` code, status, and PR link.
- `/autoapp update <task> <new instructions>` — revise a task. `<task>` is its `AUTO-XXXXXX` code or queue slot like `#2`. Before launch it rewrites the request; after launch it sends a follow-up to the running Cursor cloud agent.
- `/autoapp cancel <task>` — cancel one task and stop its Cursor cloud agent. `/autoapp cancel all` cancels every active task.
- `/autoapp mission <text>` — set or update AutoApp's overarching, durable mission, folded into every new task prompt. `/autoapp mission` shows it; `/autoapp mission clear` removes it.
- `/autoapp status` — task queue (N/5) plus open PRs with their checks and the last deployment.
- `/autoapp prs [open|closed|all]` — list pull requests with their state and CI checks.
- `/autoapp deployments` — show the last deployment and its state.
- `/autoapp vercel` — latest Vercel deployments and their state.
- `/autoapp evaluate` — review the current state of the live app.
- `/autoapp tools` — list the tools (capabilities) AutoApp can use.
- `/autoapp help`

Mentions such as `@autoapp status`, `@autoapp cancel AUTO-AB12CD`, and `@autoapp add a pricing FAQ` behave exactly like the same plain channel message — AutoApp replies in a thread under your message and streams progress there.

### Slack app configuration

Set the AutoApp Slack app up so it can read channel messages, reply, and use reactions both ways:

- **OAuth bot token scopes** (OAuth & Permissions → Bot Token Scopes):
  - `chat:write` — post replies and progress updates.
  - `app_mentions:read` — receive `@autoapp` mentions.
  - `channels:history` — read messages in the public `#general` channel (use `groups:history` if `#general` is private).
  - `reactions:read` — receive `reaction_added` events.
  - `reactions:write` — add/remove reactions (the :eyes:/:white_check_mark:/:warning: lifecycle and emotes).
  - `commands` — for the `/autoapp` slash command.
- **Event Subscriptions** (Event Subscriptions → Subscribe to bot events), request URL `https://<your-app>/api/slack/events`:
  - `message.channels` — **required** so AutoApp sees every message in `#general` (use `message.groups` for a private channel). This is what powers "just type in the channel".
  - `app_mention` — `@autoapp` mentions.
  - `reaction_added` — reacji control + the cron nudge.
- **Slash command**: create `/autoapp` with request URL `https://<your-app>/api/slack/commands`.
- **Add the bot to `#general`** and set `SLACK_GENERAL_CHANNEL_ID` to that channel's id. AutoApp only acts on its configured channel.
- **Re-install the app** after changing scopes so the new permissions take effect.

The events and slash-command endpoints acknowledge Slack within its timeout window and process work in the background (`after()`), verify request signatures with replay protection, de-duplicate Slack retries, and never let a Slack/API failure crash the handler.

## Safety rules

- AutoApp only starts work for tasks a human requests in Slack.
- AutoApp runs up to 5 tasks in parallel; extra requests are turned away until a slot frees up.
- AutoApp is authorized to merge safe PRs autonomously through the GitHub API after GitHub reports the PR is mergeable and checks are green.
- Default forbidden areas (the "Don't" guardrails in every task prompt) include auth, secrets, env vars, billing, production database writes, GitHub Actions, Vercel deployment config, Slack app permissions, and database migrations unless explicitly approved.

## Setup

1. Install dependencies: `npm install`.
2. Configure Postgres and set `DATABASE_URL`.
3. Run the Prisma migration: `npx prisma migrate deploy` (production deploys run this as part of `npm run build`).
4. Seed local data if desired: `npm run prisma:seed`.
5. Create a Slack app for AutoApp; configure the bot token and signing secret; add the bot to `#general`.
6. (Optional) Set `OPENAI_API_KEY` to power the tool-calling agent. Without it AutoApp uses a deterministic keyword router.
7. Create a Cursor API key and set `CURSOR_API_KEY` plus `CURSOR_AGENT_REPO_URL` (the GitHub repo the cloud agent should edit).
8. Create a GitHub token and set `GITHUB_TOKEN` plus `GITHUB_REPOSITORY`.
9. Connect the GitHub repository to Vercel so merges to `main` deploy automatically.
10. Set environment variables from `.env.example`, run locally with `npm run dev`, and deploy to Vercel.

## Environment variables

See `.env.example` for required and optional variables:

- `DATABASE_URL`
- `OPENAI_API_KEY` (optional): powers the Slack tool-calling agent; without it AutoApp uses the deterministic keyword router.
- `OPENAI_API_BASE_URL` (optional): override OpenAI-compatible API base URL.
- `OPENAI_AGENT_MODEL` (optional): OpenAI model used by the agent; defaults to `gpt-4o-mini`.
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `SLACK_GENERAL_CHANNEL_ID`
- `NEXT_PUBLIC_APP_URL`: the public app URL the `evaluate_app` tool reviews.
- `CURSOR_API_KEY`, `CURSOR_AGENT_REPO_URL`, `CURSOR_AGENT_STARTING_REF` (optional), `CURSOR_AGENT_MODEL` (optional), `CURSOR_API_BASE_URL` (optional)
- `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_MERGE_METHOD` (optional), `GITHUB_MERGE_REQUIRE_CHECKS` (optional), `GITHUB_PR_AUTO_MERGE` (optional), `GITHUB_CURSOR_AUTHOR_LOGIN` (optional), `GITHUB_API_BASE_URL` (optional)
- Optional bot IDs: `AUTOAPP_BOT_USER_ID`, `CURSOR_BOT_USER_ID`, `VERCEL_BOT_USER_ID`, `GITHUB_BOT_USER_ID`
- Future-only: `VERCEL_TOKEN`

## Public app

The `/` route renders a static landing page describing AutoApp as a Slack-controlled task runner. It no longer depends on any mission state.

## Architecture

- Next.js App Router and TypeScript
- Prisma with Postgres
- Slack Events API and slash commands (signature-verified, replay-protected, fast-ack with background processing)
- A tool-calling agent (`lib/agent`) backing the Slack control plane
- Cursor Cloud Agents API as the implementation worker
- GitHub REST polling and direct PR merge
- A scheduled sweep (`/api/cron/poll`) that advances in-flight tasks; Slack messages, mentions, slash commands, and reactions also nudge the same sweep on demand (important on Vercel's free plan, where the cron only runs daily)
- Vercel deployment through the connected GitHub repository
