import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  await prisma.integrationEvent.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.slackMemory.deleteMany();
  await prisma.webAppSnapshot.deleteMany();
  await prisma.cycle.deleteMany();
  await prisma.mission.deleteMany();

  const mission = await prisma.mission.create({ data: { title: "Create an app for selling a book.", description: "Create an app for selling a book.", successCriteria: "Visitors understand the book, trust the offer, and can buy or read a sample.", targetAudience: "Prospective readers", status: "active" } });
  const cycle = await prisma.cycle.create({ data: { missionId: mission.id, status: "completed", observation: "The homepage was generic and did not yet explain the book.", proposal: "Improve the homepage hero for a book landing page.", rationale: "Book-specific copy improves conversion alignment.", riskLevel: "low", acceptanceCriteria: "Add book-oriented headline\nAdd Buy the book CTA\nKeep responsive", forbiddenAreas: "auth\nsecrets\nenv vars\nGitHub Actions\nVercel deployment config", resultSummary: "Sample completed cycle: homepage copy was improved for the book mission." } });
  await prisma.slackMemory.createMany({ data: [
    { channelId: "CGENERAL", messageTs: "1710000000.000001", authorId: "UUSER", authorType: "human", rawText: "@autoapp set the mission to create an app for selling a book", normalizedText: "@autoapp set the mission to create an app for selling a book", classification: "mission_update", importance: 5, relatedCycleId: cycle.id },
    { channelId: "CGENERAL", messageTs: "1710000001.000001", authorId: "UAUTO", authorType: "autoapp", rawText: "[AUTO-SAMPLE] Proposal Improve the homepage hero.", normalizedText: "[AUTO-SAMPLE] Proposal Improve the homepage hero.", classification: "autoapp_log", importance: 3, relatedCycleId: cycle.id, extractedCycleCode: "AUTO-SAMPLE" },
    { channelId: "CGENERAL", messageTs: "1710000002.000001", authorId: "UGITHUB", authorType: "github", rawText: "GitHub PR checks passed for https://github.com/example/autoapp/pull/1", normalizedText: "GitHub PR checks passed for https://github.com/example/autoapp/pull/1", classification: "github_update", importance: 5, relatedCycleId: cycle.id, extractedPrUrl: "https://github.com/example/autoapp/pull/1" },
  ] });
  await prisma.webAppSnapshot.create({ data: { missionId: mission.id, url: "http://localhost:3000", title: "AutoApp", description: "A Slack-native autonomous app builder and operator.", extractedText: "AutoApp Turn your book into a focused sales page Buy the book Read a sample Built by AutoApp", evaluationSummary: "Sample snapshot: the page is partially aligned with the book-selling mission.", alignmentScore: 72 } });
}

main().finally(async () => prisma.$disconnect());
