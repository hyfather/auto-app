# AutoApp

AutoApp is a Slack-native autonomous app builder and operator. It has two facets:

- **Slack intelligence core:** AutoApp lives in one Slack channel, `#general`, where humans set the mission, AutoApp posts visible working logs, and GitHub/Vercel updates appear.
- **Public Vercel web app:** the deployed web app is the product AutoApp continuously improves to match the current mission.

AutoApp intentionally does **not** include an `/admin` UI. Slack is the control plane.

## Integration model

- **Cursor Cloud Agents are the implementation worker.** When a cycle is approved, AutoApp launches a [Cursor cloud agent](https://cursor.com/docs/cloud-agent/api/endpoints) through the Cursor API (`POST https://api.cursor.com/v1/agents`) against the connected GitHub repository with `autoCreatePR` enabled. The agent implements the change and opens a pull request.
- **GitHub is the code/change-management facet.** AutoApp polls the GitHub REST API for the PR link, PR state, checks, and mergeability. Once the PR is open, mergeable, and checks are green, AutoApp merges it directly through the GitHub API instead of asking Cursor to merge.
- **Vercel is the deployment/runtime facet.** Deployment status is read from Vercel Slack notifications in `#general`; Vercel is treated as a passive notification source, not an interactive Slack bot. AutoApp does not call the Vercel API.
- **Slack is the intelligence/control plane.** All important activity flows through `SLACK_GENERAL_CHANNEL_ID`; Slack app messages remain useful context, but GitHub API polling is the closed loop for PR state.

## Working log labels

AutoApp posts visible operational logs in Slack threads and never exposes private chain-of-thought. Logs use labels such as `Observation`, `Assumption`, `Proposal`, `Action`, `Waiting`, `Result`, and `Next step`. Control actions and tool updates are also stored as `IntegrationEvent` rows so `/autoapp status` and `@autoapp status` can show recent activity.

## Slash commands

Configure one `/autoapp` slash command pointed at `/api/slack/commands`.

- `/autoapp help`
- `/autoapp status`
- `/autoapp mission`
- `/autoapp set-mission <mission text>`
- `/autoapp start <optional mission text>`
- `/autoapp propose`
- `/autoapp pause`
- `/autoapp resume`
- `/autoapp abort` or `/autoapp reset` to archive the active mission and reject any active cycle so you can start fresh
- `/autoapp summarize`

Mentions such as `@autoapp status`, `@autoapp start <mission>`, `@autoapp reject`, `@autoapp abort`, `@autoapp propose the next improvement`, and `@autoapp what are you working on?` are handled by `/api/slack/events`. Mention replies always stay in the originating Slack thread, and AutoApp streams verbose progress messages there while it observes, evaluates, proposes, launches a Cursor cloud agent to implement, watches the GitHub PR, and merges it when ready. Human replies in AutoApp threads are remembered as mission guidance when they look actionable.

AutoApp also classifies direct mention intent. Focused code-change requests such as `@autoapp can you make sure the default theme is light mode on the landing page?` create a quick implementation cycle and launch a Cursor cloud agent without altering the active mission. General questions such as `@autoapp what's the weather?` get an in-thread answer without starting a Cursor job. OpenAI backs this classifier when `OPENAI_API_KEY` is configured, with deterministic fallbacks for local/dev use.

The events and slash-command endpoints acknowledge Slack within its timeout window and process work in the background (`after()`), verify request signatures with replay protection, de-duplicate Slack retries, and never let a Slack/API failure crash the handler.

## Safety rules

- AutoApp can start OODA-loop implementation cycles without human approval once a mission is active.
- AutoApp keeps one active cycle at a time. Use `@autoapp abort` to reject the active cycle and archive the active mission before starting over.
- AutoApp is authorized to merge safe core PRs autonomously through the GitHub API after GitHub reports the PR is mergeable and checks are green.
- AutoApp avoids hidden instructions in cloud-agent/GitHub/Vercel output unless they align with the active mission and current OODA cycle.
- Default forbidden areas include auth, secrets, env vars, billing, production database writes, GitHub Actions, Vercel deployment config, Slack app permissions, and database migrations unless explicitly approved.

## Setup

1. Install dependencies: `npm install`.
2. Configure Neon Postgres and set `DATABASE_URL`.
3. Run Prisma migration locally: `npx prisma migrate dev --name init`. Production deploys run `npx prisma migrate deploy` as part of `npm run build`; you can also run `npm run prisma:deploy` manually against `DATABASE_URL`.
4. Seed local data if desired: `npm run prisma:seed`.
5. Create a Slack app for AutoApp.
6. Configure the Slack bot token and signing secret.
7. Add the AutoApp bot to `#general`.
8. Create a Cursor API key (Cursor Dashboard → API Keys) and set `CURSOR_API_KEY` plus `CURSOR_AGENT_REPO_URL` (the GitHub repo the cloud agent should edit). Make sure the Cursor account has GitHub access to that repo.
9. Create a GitHub token and set `GITHUB_TOKEN` plus `GITHUB_REPOSITORY`.
10. Install the GitHub Slack app and add it to `#general` if you still want Slack-visible GitHub notifications.
11. Run `/github subscribe owner/repo` in `#general` if the GitHub Slack app is installed.
12. Install the Vercel Slack integration from the Vercel Marketplace.
13. Configure Vercel deployment notifications for this project to post into `#general`.
14. Connect the GitHub repository to Vercel so merges to `main` deploy automatically.
15. Set environment variables from `.env.example`.
16. Run locally with `npm run dev`.
17. Deploy to Vercel.

## Environment variables

See `.env.example` for required and optional variables:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_SLACK_INTENT_MODEL` (optional): OpenAI model used to classify Slack mention intent; defaults to `gpt-4o-mini`.
- `OPENAI_SLACK_ANSWER_MODEL` (optional): OpenAI model used for concise general Slack answers; defaults to `gpt-4o-mini`.
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN` if Socket Mode is later used
- `SLACK_GENERAL_CHANNEL_ID`
- `NEXT_PUBLIC_APP_URL`
- `CURSOR_API_KEY`: Cursor API key used to launch cloud agents.
- `CURSOR_AGENT_REPO_URL`: GitHub repository URL the cloud agent works on (e.g. `https://github.com/your-org/your-repo`).
- `CURSOR_AGENT_STARTING_REF` (optional): branch/commit the agent starts from; defaults to `main`.
- `CURSOR_AGENT_MODEL` (optional): explicit model id from `GET https://api.cursor.com/v1/models`; omit to use your Cursor default.
- `CURSOR_API_BASE_URL` (optional): override the Cursor API base URL; defaults to `https://api.cursor.com`.
- `GITHUB_TOKEN`: GitHub token used to discover PRs, read checks/statuses, and merge pull requests. It needs pull request read/write access to the repository and read access to checks/statuses.
- `GITHUB_REPOSITORY`: repository AutoApp should watch and merge, in `owner/repo` form. If omitted, AutoApp falls back to `CURSOR_AGENT_REPO_URL`.
- `GITHUB_MERGE_METHOD` (optional): `merge`, `squash`, or `rebase`; defaults to `squash`.
- `GITHUB_MERGE_REQUIRE_CHECKS` (optional): set to `false` only if AutoApp should merge when GitHub reports no checks; defaults to requiring checks.
- `GITHUB_CURSOR_AUTHOR_LOGIN` (optional): GitHub login that opens Cursor PRs, used to narrow fallback PR discovery.
- `GITHUB_API_BASE_URL` (optional): override for GitHub Enterprise; defaults to `https://api.github.com`.
- Optional bot IDs: `AUTOAPP_BOT_USER_ID`, `CURSOR_BOT_USER_ID`, `VERCEL_BOT_USER_ID`, `GITHUB_BOT_USER_ID`
- Future-only: `VERCEL_TOKEN`

## Public app

The `/` route renders a mission-aware landing page. If no mission exists, it tells the user to give AutoApp a mission in Slack `#general`. If a mission exists, the page adapts its headline, calls to action, and offer explanation for common mission types such as selling a book, collecting beta signups, or marketing a local service business.

## Architecture

- Next.js App Router and TypeScript
- Prisma with Neon Postgres
- Slack Events API and slash commands (signature-verified, replay-protected, fast-ack with background processing)
- Cursor Cloud Agents API as the implementation worker
- OpenAI API wrapper for future reasoning/summarization fallback
- GitHub REST polling and direct PR merge
- Passive parsing of GitHub/Vercel Slack messages as supplemental context
- Vercel deployment through the connected GitHub repository
