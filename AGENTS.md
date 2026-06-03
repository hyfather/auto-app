# AGENTS.md

## Cursor Cloud specific instructions

### Product

AutoApp is a single Next.js 15 (App Router) app at the repo root — not a monorepo. Slack is the control plane: the `/autoapp` command talks to a tool-calling agent (`lib/agent`) that turns requests into tasks and launches Cursor cloud agents. The public `/` route is a static landing page. Full operation needs Slack, OpenAI (optional), Cursor, GitHub, and Vercel integrations (see `README.md`).

### PostgreSQL (local dev)

This repo has no Docker Compose. Cloud VMs need a local Postgres instance for meaningful development:

1. Start Postgres if needed: `sudo pg_ctlcluster 16 main start` (then `pg_isready -h localhost`).
2. Create role/db once (example): user `autoapp`, password `autoapp`, database `autoapp`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` (local example: `postgresql://autoapp:autoapp@localhost:5432/autoapp` — no `sslmode=require` for localhost).
4. Apply schema: `npx prisma migrate deploy` (or `npm run prisma:migrate` interactively).
5. Optional sample data: `export $(grep -v '^#' .env | xargs) && npm run prisma:seed` — the seed script does not load `.env` by itself; export vars or use `dotenv` when invoking `tsx prisma/seed.ts` directly.

The `/` landing page is fully static and renders without `DATABASE_URL`. A database is only needed for task/queue state and Slack memory.

### Commands (see `package.json`)

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Dev server | `npm run dev` → http://localhost:3000 |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` (runs `prisma generate`, conditional migrate, then `next build`) |
| DB deploy migrate | `npm run prisma:deploy` |

There is **no** `npm test` script or test runner in this repo.

### Running the dev server

Load env before `npm run dev` if `.env` is not picked up automatically: `export $(grep -v '^#' .env | xargs) && npm run dev`. Prefer a tmux session for long-running servers.

### Smoke / hello-world (no Slack required)

1. Seed DB (above), start dev server.
2. Open `/` — should show the static AutoApp landing page hero (“Turn Slack requests into shipped code.”).
3. `GET http://localhost:3000/api/cron/poll` — advances any in-flight tasks (poll Cursor runs, reconcile/merge PRs); returns `{ status: "ok", ... }`.

Slack webhooks (`/api/slack/*`) need valid `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and a public URL (e.g. ngrok) for real E2E.
