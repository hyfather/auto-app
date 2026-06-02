import { getLatestCycle } from "./cycle";
import { formatCycleCode } from "./policies";

export async function summarizeLatestCycle() {
  const cycle = await getLatestCycle();
  if (!cycle) return "No cycles have been created yet.";
  const code = formatCycleCode(cycle.id);
  const updates = cycle.memories.map((m) => `- ${m.classification}: ${m.normalizedText}`).join("\n") || "No related Slack updates recorded yet.";
  return `[${code}] Result\nStatus: ${cycle.status}.\nMission: ${cycle.mission.title}.\nProposal: ${cycle.proposal}.\nLatest related updates:\n${updates}\nNext step: ${cycle.status === "proposed" ? "AutoApp can approve and execute autonomously; use reject/pause only if you want to stop it." : "Keep watching #general for GitHub/Vercel updates while the Cursor cloud agent works."}`;
}
