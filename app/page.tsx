import { Footer } from "@/components/public/Footer";
import { Hero } from "@/components/public/Hero";
import { Offer } from "@/components/public/Offer";
import { NotifyForm } from "@/components/public/NotifyForm";

export default function Home() {
  return (
    <main className="page">
      <div className="shell">
        <nav className="nav">
          <div className="brand">This Week in SF</div>
          <div className="pill">Fresh picks every Monday</div>
        </nav>
        <Hero />
        <Offer />
        <section className="subscribe" id="subscribe">
          <div className="card">
            <h2>Get the weekly roundup</h2>
            <p>One short email every Monday with the most interesting events in San Francisco. No spam—unsubscribe anytime.</p>
            <NotifyForm source="landing_page" />
          </div>
        </section>
        <Footer />
      </div>
    </main>
  );
}
