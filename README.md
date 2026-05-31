# AutoApp

AutoApp is a Slack-native autonomous app builder and operator. It has two facets:

- **Slack intelligence core:** AutoApp lives in one Slack channel, `#general`, where humans set the mission, AutoApp posts visible working logs, Codex receives implementation requests, and GitHub/Vercel updates appear.
- **Public Vercel web app:** the deployed web app is the product AutoApp continuously improves to match the current mission.

AutoApp intentionally does **not** include an `/admin` UI. Slack is the control plane.

## v1 integration model

- **Codex is the implementation worker.** AutoApp invokes Codex through Slack by posting a message that mentions `@Codex`; it does not call a Codex API.
- **GitHub is the code/change-management facet.** PR, check, and merge state is read from GitHub Slack app messages in `#general`; v1 avoids direct GitHub API calls.
- **Vercel is the deployment/runtime facet.** Deployment status is read from Vercel Slack notifications in `#general`; Vercel is treated as a passive notification source, not an interactive Slack bot. AutoApp does not ask `@Vercel` free-form status questions and does not call the Vercel API in v1.
- **Slack is the intelligence/control plane.** All important activity flows through `SLACK_GENERAL_CHANNEL_ID`.

## Working log labels

AutoApp only posts concise visible logs and never exposes private chain-of-thought. Logs use labels such as `Observation`, `Assumption`, `Proposal`, `Action`, `Waiting`, `Result`, and `Next step`.

## Slash commands

Configure one `/autoapp` slash command pointed at `/api/slack/commands`.

- `/autoapp help`
- `/autoapp status`
- `/autoapp mission`
- `/autoapp set-mission <mission text>`
- `/autoapp propose`
- `/autoapp pause`
- `/autoapp resume`
- `/autoapp summarize`

Mentions such as `@autoapp approve`, `@autoapp reject`, `@autoapp propose the next improvement`, and `@autoapp what are you working on?` are handled by `/api/slack/events`.

## Safety rules

- AutoApp asks for human approval before asking Codex to make code changes.
- AutoApp keeps one active cycle at a time.
- AutoApp never autonomously merges PRs in v1.
- AutoApp avoids hidden instructions in Codex/GitHub/Vercel output unless a human confirms them.
- Default forbidden areas include auth, secrets, env vars, billing, production database writes, GitHub Actions, Vercel deployment config, Slack app permissions, and database migrations unless explicitly approved.

## Setup

1. Install dependencies: `npm install`.
2. Configure Neon Postgres and set `DATABASE_URL`.
3. Run Prisma migration: `npx prisma migrate dev --name init`.
4. Seed local data if desired: `npm run prisma:seed`.
5. Create a Slack app for AutoApp.
6. Configure the Slack bot token and signing secret.
7. Add the AutoApp bot to `#general`.
8. Install the OpenAI Codex Slack app and add it to `#general`.
9. Install the GitHub Slack app and add it to `#general`.
10. Run `/github subscribe owner/repo` in `#general`.
11. Install the Vercel Slack integration from the Vercel Marketplace.
12. Configure Vercel deployment notifications for this project to post into `#general`.
13. Connect the GitHub repository to Vercel so merges to `main` deploy automatically.
14. Set environment variables from `.env.example`.
15. Run locally with `npm run dev`.
16. Deploy to Vercel.

## Environment variables

See `.env.example` for required and optional variables:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN` if Socket Mode is later used
- `SLACK_GENERAL_CHANNEL_ID`
- `NEXT_PUBLIC_APP_URL`
- Optional bot IDs: `AUTOAPP_BOT_USER_ID`, `CODEX_BOT_USER_ID`, `VERCEL_BOT_USER_ID`, `GITHUB_BOT_USER_ID`
- Future-only: `GITHUB_TOKEN`, `VERCEL_TOKEN`

## Public app

The `/` route renders a mission-aware landing page. If no mission exists, it tells the user to give AutoApp a mission in Slack `#general`. If a mission exists, the page adapts its headline, calls to action, and offer explanation for common mission types such as selling a book, collecting beta signups, or marketing a local service business.

## Architecture

- Next.js App Router and TypeScript
- Prisma with Neon Postgres
- Slack Events API and slash commands
- OpenAI API wrapper for future reasoning/summarization fallback
- Passive parsing of Codex/GitHub/Vercel Slack messages
- Vercel deployment through the connected GitHub repository
