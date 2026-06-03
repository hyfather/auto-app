-- Production-safety preamble.
--
-- This migration removes Missions/Cycles/Evaluation and reshapes the data model
-- around Tasks. The original auto-generated version assumed empty tables and
-- failed on databases that already had data because:
--   * Decision rows used DecisionType values that are being removed
--     (approved/rejected/paused/resumed/rollback_requested), so the enum cast
--     below aborted, and a NOT NULL `taskId` column cannot be added to a table
--     that still has rows.
--   * SlackMemory rows could carry the removed `mission_update` classification.
--
-- Decisions were entirely Cycle-scoped (Cycles are being dropped), so they are
-- safe to clear here. SlackMemory rows are kept; the removed classification is
-- remapped to `human_instruction`.
DELETE FROM "Decision";
UPDATE "SlackMemory" SET "classification" = 'human_instruction' WHERE "classification" = 'mission_update';

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('queued', 'waiting_for_agent', 'pr_opened', 'waiting_for_checks', 'waiting_for_preview_deploy', 'preview_deployed', 'waiting_for_merge', 'waiting_for_production_deploy', 'production_deployed', 'completed', 'failed', 'cancelled');

-- AlterEnum
BEGIN;
CREATE TYPE "DecisionType_new" AS ENUM ('merge_recommended', 'cancelled');
ALTER TABLE "Decision" ALTER COLUMN "decision" TYPE "DecisionType_new" USING ("decision"::text::"DecisionType_new");
ALTER TYPE "DecisionType" RENAME TO "DecisionType_old";
ALTER TYPE "DecisionType_new" RENAME TO "DecisionType";
DROP TYPE "DecisionType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "MemoryClassification_new" AS ENUM ('human_instruction', 'human_approval', 'human_rejection', 'cursor_update', 'github_update', 'vercel_update', 'autoapp_log', 'general_noise', 'unknown');
ALTER TABLE "SlackMemory" ALTER COLUMN "classification" DROP DEFAULT;
ALTER TABLE "SlackMemory" ALTER COLUMN "classification" TYPE "MemoryClassification_new" USING ("classification"::text::"MemoryClassification_new");
ALTER TYPE "MemoryClassification" RENAME TO "MemoryClassification_old";
ALTER TYPE "MemoryClassification_new" RENAME TO "MemoryClassification";
DROP TYPE "MemoryClassification_old";
ALTER TABLE "SlackMemory" ALTER COLUMN "classification" SET DEFAULT 'unknown';
COMMIT;

-- DropForeignKey
ALTER TABLE "Cycle" DROP CONSTRAINT "Cycle_missionId_fkey";

-- DropForeignKey
ALTER TABLE "Decision" DROP CONSTRAINT "Decision_cycleId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationEvent" DROP CONSTRAINT "IntegrationEvent_relatedCycleId_fkey";

-- DropForeignKey
ALTER TABLE "SlackMemory" DROP CONSTRAINT "SlackMemory_relatedCycleId_fkey";

-- DropForeignKey
ALTER TABLE "WebAppSnapshot" DROP CONSTRAINT "WebAppSnapshot_missionId_fkey";

-- AlterTable
ALTER TABLE "Decision" DROP COLUMN "cycleId",
ADD COLUMN     "taskId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "IntegrationEvent" DROP COLUMN "relatedCycleId",
ADD COLUMN     "relatedTaskId" TEXT;

-- AlterTable
ALTER TABLE "SlackMemory" DROP COLUMN "extractedCycleCode",
DROP COLUMN "relatedCycleId",
ADD COLUMN     "extractedTaskCode" TEXT,
ADD COLUMN     "relatedTaskId" TEXT;

-- DropTable
DROP TABLE "Cycle";

-- DropTable
DROP TABLE "Mission";

-- DropTable
DROP TABLE "WebAppSnapshot";

-- DropEnum
DROP TYPE "CycleStatus";

-- DropEnum
DROP TYPE "MissionStatus";

-- DropEnum
DROP TYPE "RiskLevel";

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "request" TEXT NOT NULL,
    "acceptanceCriteria" TEXT NOT NULL,
    "forbiddenAreas" TEXT NOT NULL,
    "slackRootTs" TEXT,
    "cursorAgentId" TEXT,
    "cursorRunId" TEXT,
    "cursorAgentUrl" TEXT,
    "githubPrUrl" TEXT,
    "vercelPreviewUrl" TEXT,
    "vercelProductionUrl" TEXT,
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SlackMemory" ADD CONSTRAINT "SlackMemory_relatedTaskId_fkey" FOREIGN KEY ("relatedTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_relatedTaskId_fkey" FOREIGN KEY ("relatedTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
