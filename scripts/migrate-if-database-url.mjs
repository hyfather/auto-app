import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.warn("Skipping Prisma migrations because DATABASE_URL is not set.");
  process.exit(0);
}

// A migration whose first deploy attempt failed leaves the database with a
// failed migration record (Prisma error P3009), which blocks every subsequent
// `migrate deploy`. The tasks_remove_missions migration is fully transactional,
// so a failed attempt rolled its DDL back — it is safe to mark it rolled back
// and re-apply the corrected, data-safe version. We only auto-recover this one
// known migration, and only when deploy actually reports it as failed.
const RECOVERABLE_FAILED_MIGRATION = "20260603190000_tasks_remove_missions";

function runPrisma(args) {
  const result = spawnSync("npx", ["prisma", ...args], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

let result = runPrisma(["migrate", "deploy"]);

const output = `${result.stdout || ""}${result.stderr || ""}`;
if ((result.status ?? 1) !== 0 && output.includes("P3009") && output.includes(RECOVERABLE_FAILED_MIGRATION)) {
  console.warn(`Detected a failed '${RECOVERABLE_FAILED_MIGRATION}' migration; marking it rolled back and retrying deploy.`);
  runPrisma(["migrate", "resolve", "--rolled-back", RECOVERABLE_FAILED_MIGRATION]);
  result = runPrisma(["migrate", "deploy"]);
}

process.exit(result.status ?? 1);
