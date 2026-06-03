import { Footer } from "@/components/public/Footer";
import { Hero } from "@/components/public/Hero";
import { Offer } from "@/components/public/Offer";

export default function Home() {
  return (
    <main className="page">
      <div className="shell">
        <nav className="nav">
          <div className="brand">AutoApp</div>
          <div className="pill">Controlled from Slack #general</div>
        </nav>
        <Hero />
        <Offer />
        <Footer />
      </div>
    </main>
  );
}
