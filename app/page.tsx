import { Footer } from "@/components/public/Footer";
import { Hero } from "@/components/public/Hero";
import { MissionSection } from "@/components/public/MissionSection";
import { getActiveMission } from "@/lib/autoapp/mission";

export default async function Home() {
  const mission = process.env.DATABASE_URL ? await getActiveMission().catch(() => null) : null;
  return <main className="page"><div className="shell"><nav className="nav"><div className="brand">AutoApp</div><div className="pill">Controlled from Slack #general</div></nav><Hero missionTitle={mission?.title} /><MissionSection missionTitle={mission?.title} /><Footer /></div></main>;
}
