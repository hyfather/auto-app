import { CTA } from "./CTA";

export function Hero() {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">For teams &amp; builders who ship from Slack</p>
        <h1>Turn Slack requests into shipped code.</h1>
        <p className="lead">
          AutoApp takes a request in Slack, hands it to a Cursor cloud agent, and watches the pull request all the way to a
          merge on <code>main</code>—up to five tasks running in parallel. No mission to define, no dashboards to babysit:
          just describe the change you want.
        </p>
        <CTA primary="See how it works" secondary="Explore the offer" primaryHref="#offer" secondaryHref="#details" />
      </div>
      <aside className="card">
        <h2>How it works</h2>
        <p>Ask in Slack: <em>&ldquo;@autoapp add a pricing FAQ section&rdquo;</em>.</p>
        <p className="built">AutoApp queues a task, launches a Cursor cloud agent, opens a PR, and merges it once GitHub checks pass.</p>
      </aside>
    </section>
  );
}
