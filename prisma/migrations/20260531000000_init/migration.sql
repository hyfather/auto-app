CREATE TYPE "MissionStatus" AS ENUM ('active', 'paused', 'archived');
CREATE TYPE "CycleStatus" AS ENUM ('observing', 'proposed', 'approved', 'running', 'waiting_for_codex', 'pr_opened', 'waiting_for_checks', 'waiting_for_preview_deploy', 'preview_deployed', 'waiting_for_merge', 'waiting_for_production_deploy', 'production_deployed', 'completed', 'failed', 'rejected');
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');
CREATE TYPE "AuthorType" AS ENUM ('human', 'autoapp', 'codex', 'github', 'vercel', 'unknown');
CREATE TYPE "MemoryClassification" AS ENUM ('human_instruction', 'human_approval', 'human_rejection', 'codex_update', 'github_update', 'vercel_update', 'autoapp_log', 'mission_update', 'general_noise', 'unknown');
CREATE TYPE "DecisionType" AS ENUM ('approved', 'rejected', 'paused', 'resumed', 'merge_recommended', 'rollback_requested');
CREATE TYPE "IntegrationSource" AS ENUM ('slack', 'codex', 'github', 'vercel', 'autoapp');

CREATE TABLE "Mission" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "successCriteria" TEXT NOT NULL,
  "targetAudience" TEXT,
  "status" "MissionStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Cycle" (
  "id" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "status" "CycleStatus" NOT NULL DEFAULT 'observing',
  "observation" TEXT NOT NULL,
  "proposal" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "riskLevel" "RiskLevel" NOT NULL DEFAULT 'low',
  "acceptanceCriteria" TEXT NOT NULL,
  "forbiddenAreas" TEXT NOT NULL,
  "slackRootTs" TEXT,
  "codexRequestTs" TEXT,
  "githubPrUrl" TEXT,
  "vercelPreviewUrl" TEXT,
  "vercelProductionUrl" TEXT,
  "resultSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlackMemory" (
  "id" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageTs" TEXT NOT NULL,
  "threadTs" TEXT,
  "authorId" TEXT NOT NULL,
  "authorType" "AuthorType" NOT NULL DEFAULT 'unknown',
  "rawText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "classification" "MemoryClassification" NOT NULL DEFAULT 'unknown',
  "importance" INTEGER NOT NULL DEFAULT 0,
  "relatedCycleId" TEXT,
  "extractedPrUrl" TEXT,
  "extractedDeploymentUrl" TEXT,
  "extractedCycleCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlackMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Decision" (
  "id" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "decision" "DecisionType" NOT NULL,
  "decidedBySlackUserId" TEXT NOT NULL,
  "rationale" TEXT,
  "slackMessageTs" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationEvent" (
  "id" TEXT NOT NULL,
  "source" "IntegrationSource" NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "relatedCycleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebAppSnapshot" (
  "id" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "title" TEXT,
  "description" TEXT,
  "extractedText" TEXT NOT NULL,
  "evaluationSummary" TEXT NOT NULL,
  "alignmentScore" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebAppSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackMemory_channelId_messageTs_key" ON "SlackMemory"("channelId", "messageTs");
CREATE INDEX "SlackMemory_channelId_createdAt_idx" ON "SlackMemory"("channelId", "createdAt");
CREATE INDEX "SlackMemory_classification_createdAt_idx" ON "SlackMemory"("classification", "createdAt");
CREATE INDEX "IntegrationEvent_source_eventType_createdAt_idx" ON "IntegrationEvent"("source", "eventType", "createdAt");

ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackMemory" ADD CONSTRAINT "SlackMemory_relatedCycleId_fkey" FOREIGN KEY ("relatedCycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_relatedCycleId_fkey" FOREIGN KEY ("relatedCycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebAppSnapshot" ADD CONSTRAINT "WebAppSnapshot_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
