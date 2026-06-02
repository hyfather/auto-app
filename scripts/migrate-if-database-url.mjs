import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.warn("Skipping Prisma migrations because DATABASE_URL is not set.");
  process.exit(0);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
