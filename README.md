# AutoApp

AutoApp is a Slack-native autonomous app builder and operator. It has two facets:

- **Slack control plane:** AutoApp lives in one Slack channel, `#general`. The `/autoapp` command (and `@autoapp` mentions) talk to a **tool-calling agent** that turns your requests into tasks, launches Cursor cloud agents, and reports status. GitHub/Vercel updates also appear here.
- **Public Vercel web app:** the deployed web app at `/` is the product AutoApp ships changes to.

AutoApp intentionally does **not** include an `/admin` UI. Slack is the control plane.

There is no automatic web-app scoring. AutoApp only acts on **tasks** a human requests in Slack. You can optionally set one overarching, durable **mission** (`/autoapp mission <text>`) that is folded into the prompt of every new Cursor cloud agent task alongside the specific request.

## The tool-calling agent

The Slack backend is a tool-calling agent (`lib/agent`). When you message AutoApp, the agent decides which tool to call:

- `create_task` — launch a Cursor cloud agent to implement a focused change (this is how "invoking the Cursor agent" happens).
- `list_tasks`, `cancel_task`, `update_task` — manage the task queue.
- `get_status`, `list_pull_requests`, `get_deployments` — read live state from GitHub.
- `evaluate_app` — review the current state of the live app (fetches the homepage and returns status/title/text). This is the seed for richer future evaluation tools.

When `OPENAI_API_KEY` is set, the agent runs an OpenAI function-calling loop (`OPENAI_AGENT_MODEL`, default `gpt-4o-mini`). When it is not set, AutoApp falls back to a deterministic keyword router that calls the same tools, so the control plane keeps working without an LLM.

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

## Slash commands and mentions

Configure one `/autoapp` slash command pointed at `/api/slack/commands`. Everything except `help` is routed through the tool-calling agent.

- Just describe a change: `/autoapp make the landing page default to light mode` (or `/autoapp new <request>`) — AutoApp queues a task and launches a Cursor cloud agent.
- `/autoapp queue` (aliases `tasks`, `list`) — list every queued/in-flight task with its `AUTO-XXXXXX` code, status, and PR link.
- `/autoapp update <task> <new instructions>` — revise a task. `<task>` is its `AUTO-XXXXXX` code or queue slot like `#2`. Before launch it rewrites the request; after launch it sends a follow-up to the running Cursor cloud agent.
- `/autoapp cancel <task>` — cancel one task and stop its Cursor cloud agent. `/autoapp cancel all` cancels every active task.
- `/autoapp mission <text>` — set or update AutoApp's overarching, durable mission, folded into every new task prompt. `/autoapp mission` shows it; `/autoapp mission clear` removes it.
- `/autoapp status` — task queue (N/5) plus open PRs with their checks and the last deployment.
- `/autoapp prs [open|closed|all]` — list pull requests with their state and CI checks.
- `/autoapp deployments` — show the last deployment and its state.
- `/autoapp evaluate` — review the current state of the live app.
- `/autoapp help`

Mentions such as `@autoapp status`, `@autoapp queue`, `@autoapp prs`, `@autoapp cancel AUTO-AB12CD`, and `@autoapp add a pricing FAQ` are handled by `/api/slack/events` and behave exactly like the equivalent `/autoapp` slash command. A top-level mention makes AutoApp open its own fresh thread in `#general` and stream progress there (the same as a slash command) rather than threading the work under your message. Mentions you make as a reply inside an existing thread stay in that thread so follow-ups read naturally.

Reacting to a message in `#general` (for example adding any emoji to one of AutoApp's status posts) wakes AutoApp up: the `reaction_added` event advances every in-flight task on demand. This matters on Vercel's free plan, where the scheduled cron (`/api/cron/poll`) only runs once a day — a reaction lets you push tasks forward between cron runs without typing a command. Subscribe the Slack app's bot events to `reaction_added` (alongside `app_mention` and `message.channels`) for this to fire.

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
