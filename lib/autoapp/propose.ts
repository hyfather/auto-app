import type { Mission } from "@prisma/client";
import type { WebAppEvaluation } from "./webAppEvaluator";
import { DEFAULT_CONSTRAINTS, DEFAULT_FORBIDDEN_AREAS } from "./policies";

export type Proposal = {
  observation: string;
  proposedChange: string;
  rationale: string;
  riskLevel: "low" | "medium" | "high";
  constraints: string[];
  acceptanceCriteria: string[];
  forbiddenAreas: string[];
};

export function proposeNextChange(mission: Mission, evaluation: WebAppEvaluation): Proposal {
  const isBook = /book|author|novel|ebook/i.test(mission.description);
  const isBeta = /beta|signup|waitlist|sign up/i.test(mission.description);
  const isLocal = /local|service|booking|appointment/i.test(mission.description);

  const proposedChange = isBook
    ? "Improve the public homepage hero and offer section so it reads like a book landing page with buying and sample-reading calls to action."
    : isBeta
      ? "Improve the public homepage hero and signup-oriented section so visitors understand the beta value proposition and next step."
      : isLocal
        ? "Improve the public homepage hero and service section so local customers understand the offer and how to request service."
        : "Improve the public homepage hero and offer section so it directly reflects the active mission.";

  const acceptanceCriteria = isBook
    ? ["Homepage has a book-oriented headline", "Primary CTA says “Buy the book”", "Secondary CTA says “Read a sample”", "Offer section explains who the book is for", "Page remains responsive", "No admin UI is added"]
    : isBeta
      ? ["Homepage has a beta-signup-oriented headline", "Primary CTA invites visitors to join the beta", "Offer section explains the value proposition", "Page remains responsive", "No admin UI is added"]
      : isLocal
        ? ["Homepage has a local-service-oriented headline", "Primary CTA invites booking or contact", "Offer section explains services and service area", "Page remains responsive", "No admin UI is added"]
        : ["Homepage headline reflects the mission", "Primary CTA is mission-specific", "Offer section explains the current product", "Page remains responsive", "No admin UI is added"];

  return {
    observation: `Current mission: ${mission.title}. ${evaluation.evaluationSummary} Missing or weak elements: ${evaluation.missingElements.join(", ") || "none detected"}.`,
    proposedChange,
    rationale: "A small homepage copy/UI improvement is low-risk, reversible, and directly improves mission alignment for public visitors.",
    riskLevel: "low",
    constraints: DEFAULT_CONSTRAINTS,
    acceptanceCriteria,
    forbiddenAreas: DEFAULT_FORBIDDEN_AREAS,
  };
}
