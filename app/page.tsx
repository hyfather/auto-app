import type { Metadata } from "next";
import { Footer } from "@/components/public/Footer";
import { Hero } from "@/components/public/Hero";
import { MissionSection } from "@/components/public/MissionSection";
import { getActiveMission } from "@/lib/autoapp/mission";

function isAutoMergeMission(title?: string | null) {
  return !!title && /auto.?merge|cursor.*(pr|pull request)|merge.*(check|pass)|checks?.*(pass|green)/i.test(title);
}

export async function generateMetadata(): Promise<Metadata> {
  const mission = process.env.DATABASE_URL ? await getActiveMission().catch(() => null) : null;
  if (isAutoMergeMission(mission?.title)) {
    return {
      title: "Auto-merge Cursor PRs when GitHub checks pass | AutoApp",
      description: "AutoApp lets Cursor open pull requests that auto-merge as soon as every required GitHub status check passes—hands-off PR delivery for engineering teams using Cursor and GitHub Actions.",
    };
  }
  return {};
}

export default async function Home() {
  const mission = process.env.DATABASE_URL ? await getActiveMission().catch(() => null) : null;
  return <main className="page"><div className="shell"><nav className="nav"><div className="brand">AutoApp</div><div className="pill">Controlled from Slack #general</div></nav><Hero missionTitle={mission?.title} /><MissionSection missionTitle={mission?.title} /><Footer /></div></main>;
}
