export function Offer() {
  return (
    <section className="sections" id="offer">
      <div className="card" id="details">
        <h2>What you get</h2>
        <p>A Slack-native way to ship small, reviewable changes to this app without leaving your workspace.</p>
        <ul>
          <li><strong>Slack as your command center</strong> — describe a change and AutoApp turns it into a task</li>
          <li><strong>Cursor cloud agents do the work</strong> — each task opens a pull request against <code>main</code></li>
          <li><strong>Up to 5 tasks in parallel</strong> — extra requests are turned away until a slot frees up</li>
        </ul>
      </div>
      <div className="card">
        <h2>Why teams trust AutoApp</h2>
        <p>The control plane lives in Slack—where your team already works. AutoApp opens PRs, watches their checks, and merges them automatically once they&apos;re green.</p>
        <ul>
          <li><strong>Transparent process</strong> — every change is a reviewable pull request, never a black-box update</li>
          <li><strong>No admin UI exposed</strong> — end users see only the polished public app</li>
          <li><strong>Built on open standards</strong> — Next.js, Cursor cloud agents, GitHub, and Vercel</li>
        </ul>
      </div>
    </section>
  );
}
