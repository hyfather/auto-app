# Auto App

Auto App is a Vercel-ready Next.js starter for applications that include their own self-improvement harness. It is designed for a world where a human operator sets a mission, the app gathers improvement ideas from people or usage signals, and an LLM-backed coding loop turns those ideas into small, validated pull requests.

## What is built in

- A public product surface that explains the self-improvement loop and lets an operator submit a mission plus an idea.
- `/api/improve`, a dry-run-first planning endpoint that validates an idea and returns the staged improvement workflow.
- `/api/metrics`, a placeholder metrics endpoint for the future subagent loop that will analyze usage and keep the app aligned to its mission.
- `/admin`, an operator console for the protected control plane.
- Bearer-token protected admin APIs for listing, creating, approving, rejecting, dispatching, validating, and merging improvement runs.
- A policy engine that triages risk, decides whether human approval is required, and blocks fully manual high-risk work.
- An in-memory audit log for each improvement run so creation, triage, approvals, rejections, and agent-loop actions are explainable.
- A dry-run agentic discovery loop that converts mission and metrics signals into queued improvement runs.
- A TypeScript harness that models capture, triage, planning, implementation, validation, GitHub PR creation, Vercel preview observation, and merge gates.
- A GitHub integration seam using the GitHub REST API for draft pull requests when the operator disables dry-run mode.

## Required environment variables

```bash
OPENAI_API_KEY=...              # Enables codex-style planning/implementation providers
ANTHROPIC_API_KEY=...           # Enables opus-style planning/implementation providers
AUTO_APP_MODEL=provider-default # or opus-4.8 / codex-5.5 when your provider supports it
AUTO_APP_ADMIN_TOKEN=...        # Required for /api/admin/* control-plane calls
GITHUB_OWNER=...
GITHUB_REPO=...
GITHUB_TOKEN=...
AUTO_APP_BASE_BRANCH=main
VERCEL_PROJECT_PRODUCTION_URL=...
```

The harness intentionally starts in dry-run mode. Production deployments should keep direct writes disabled until validation, approval, branch protection, durable storage, and audit logging policies are in place.

## Admin API quick reference

All `/api/admin/*` routes require `Authorization: Bearer $AUTO_APP_ADMIN_TOKEN`.

- `GET /api/admin/runs` lists queued improvement runs.
- `POST /api/admin/runs` creates a run from a validated idea payload.
- `GET /api/admin/runs/:id` returns a specific run and its audit log.
- `POST /api/admin/runs/:id/approve` records an approval reason and moves the run to `approved`.
- `POST /api/admin/runs/:id/reject` records a rejection reason and moves the run to `rejected`.
- `POST /api/admin/runs/:id/dispatch` moves an approved run into execution.
- `POST /api/admin/runs/:id/validate` records validation checks and marks the run `ready-to-merge`.
- `POST /api/admin/runs/:id/merge` merges only non-dry-run work that has passed validation.
- `POST /api/admin/agent-loop` runs dry-run agentic discovery from mission and metrics signals.

The current store is intentionally in-memory for the scaffold. Use a durable database or queue before relying on this in production serverless deployments.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test:harness
```

## Example idea

> Build an app that sends personalized birthday greeting cards from a user's saved contacts and style preferences.

The current harness turns that idea into an implementation plan with safety gates. The next layer can connect a coding model provider, a sandboxed worktree, durable queue, and preview smoke tests so the plan becomes a pull request that Vercel can deploy and validate.
