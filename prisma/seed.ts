import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  await prisma.integrationEvent.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.slackMemory.deleteMany();
  await prisma.task.deleteMany();

  const task = await prisma.task.create({
    data: {
      status: "completed",
      request: "Make the landing page default to a light theme.",
      acceptanceCriteria: ["Landing page uses a light background by default", "Text contrast stays accessible", "Page remains responsive"].join("\n"),
      forbiddenAreas: ["auth", "secrets", "env vars", "GitHub Actions", "Vercel deployment config"].join("\n"),
      githubPrUrl: "https://github.com/example/autoapp/pull/1",
      resultSummary: "Sample completed task: the landing page was switched to a light theme and the PR merged into main.",
    },
  });

  await prisma.slackMemory.createMany({
    data: [
      { channelId: "CGENERAL", messageTs: "1710000000.000001", authorId: "UUSER", authorType: "human", rawText: "@autoapp make the landing page light mode", normalizedText: "@autoapp make the landing page light mode", classification: "human_instruction", importance: 4, relatedTaskId: task.id },
      { channelId: "CGENERAL", messageTs: "1710000001.000001", authorId: "UAUTO", authorType: "autoapp", rawText: "[AUTO-SAMPLE] Action Launched a Cursor cloud agent.", normalizedText: "[AUTO-SAMPLE] Action Launched a Cursor cloud agent.", classification: "autoapp_log", importance: 3, relatedTaskId: task.id, extractedTaskCode: "AUTO-SAMPLE" },
      { channelId: "CGENERAL", messageTs: "1710000002.000001", authorId: "UGITHUB", authorType: "github", rawText: "GitHub PR checks passed for https://github.com/example/autoapp/pull/1", normalizedText: "GitHub PR checks passed for https://github.com/example/autoapp/pull/1", classification: "github_update", importance: 5, relatedTaskId: task.id, extractedPrUrl: "https://github.com/example/autoapp/pull/1" },
    ],
  });
}

main().finally(async () => prisma.$disconnect());
