-- Replace the Codex implementation worker with Cursor Cloud Agents.
-- Enum value renames preserve existing row data (labels are renamed in place).

ALTER TYPE "CycleStatus" RENAME VALUE 'waiting_for_codex' TO 'waiting_for_agent';
ALTER TYPE "AuthorType" RENAME VALUE 'codex' TO 'cursor';
ALTER TYPE "MemoryClassification" RENAME VALUE 'codex_update' TO 'cursor_update';
ALTER TYPE "IntegrationSource" RENAME VALUE 'codex' TO 'cursor';

-- Drop the Slack-mention bookkeeping column and add Cloud Agent tracking columns.
ALTER TABLE "Cycle" DROP COLUMN IF EXISTS "codexRequestTs";
ALTER TABLE "Cycle" ADD COLUMN IF NOT EXISTS "cursorAgentId" TEXT;
ALTER TABLE "Cycle" ADD COLUMN IF NOT EXISTS "cursorRunId" TEXT;
ALTER TABLE "Cycle" ADD COLUMN IF NOT EXISTS "cursorAgentUrl" TEXT;
