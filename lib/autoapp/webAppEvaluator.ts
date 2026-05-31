import { prisma } from "@/lib/db";
import type { Mission } from "@prisma/client";

export type WebAppEvaluation = {
  url: string;
  title?: string;
  description?: string;
  extractedText: string;
  evaluationSummary: string;
  alignmentScore: number;
  missingElements: string[];
  opportunities: string[];
  recommendedNextSmallChange: string;
};

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(html: string, pattern: RegExp) {
  return html.match(pattern)?.[1]?.replace(/\s+/g, " ").trim();
}

export async function evaluateWebAppAgainstMission(mission: Mission): Promise<WebAppEvaluation> {
  const url = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const extractedText = stripHtml(html).slice(0, 8000);
    const lower = extractedText.toLowerCase();
    const missionTerms = mission.description.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
    const hits = missionTerms.filter((term) => lower.includes(term)).length;
    const score = Math.max(10, Math.min(95, Math.round((hits / Math.max(1, missionTerms.length)) * 70 + (lower.includes("built by autoapp") ? 10 : 0))));
    const missingElements = ["clear primary CTA", "specific target audience", "trust or proof section", "SEO-focused description"].filter((item) => !lower.includes(item.split(" ")[0]));
    const evaluationSummary = `Inspected ${url}. The page currently scores ${score}/100 against the mission: ${mission.title}.`;
    const result = {
      url,
      title: extractTag(html, /<title>(.*?)<\/title>/i),
      description: extractTag(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)/i),
      extractedText,
      evaluationSummary,
      alignmentScore: score,
      missingElements,
      opportunities: ["Make the hero more mission-specific", "Add conversion-oriented CTA copy", "Add a compact offer explanation"],
      recommendedNextSmallChange: "Improve the homepage hero and offer section so they directly reflect the active mission.",
    };
    await prisma.webAppSnapshot.create({ data: { missionId: mission.id, url, title: result.title, description: result.description, extractedText, evaluationSummary, alignmentScore: score } });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const fallback = `Could not inspect ${url}: ${message}. Falling back to mission and recent Slack context.`;
    await prisma.webAppSnapshot.create({ data: { missionId: mission.id, url, extractedText: "", evaluationSummary: fallback, alignmentScore: null } });
    return { url, extractedText: "", evaluationSummary: fallback, alignmentScore: 0, missingElements: ["deployment inspection unavailable"], opportunities: ["Verify the public homepage is reachable"], recommendedNextSmallChange: "Make a small mission-aligned homepage improvement once the deployed page can be inspected." };
  }
}
