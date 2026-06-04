import { CTA } from "./CTA";

export function Hero() {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">For everyone curious about San Francisco</p>
        <h1>The most interesting events in SF, every week.</h1>
        <p className="lead">
          This Week in SF is your weekly guide to what&apos;s actually worth leaving the house for—warehouse art shows,
          neighborhood pop-ups, late-night hackathons, and one-night-only happenings. We comb the city so you find the good
          stuff before it sells out.
        </p>
        <CTA primary="See this week's picks" secondary="How it works" primaryHref="#offer" secondaryHref="#details" />
      </div>
      <aside className="card">
        <h2>This week in the city</h2>
        <p>Think: <em>&ldquo;A rooftop film night in the Mission and a free jazz set in North Beach.&rdquo;</em></p>
        <p className="built">A hand-picked roundup lands every Monday—curated, never an endless calendar to scroll.</p>
      </aside>
    </section>
  );
}
