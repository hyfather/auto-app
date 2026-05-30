import { IdeaConsole } from "./idea-console";
import { getHarnessConfig } from "@/lib/auto-app/config";

const workflow = [
  "Capture a human idea or agent-generated insight.",
  "Ask a coding model for a constrained implementation plan.",
  "Create a branch, produce code, and open a GitHub pull request.",
  "Let Vercel deploy the branch and run preview validation.",
  "Merge only when tests, metrics, and approval gates pass."
];

export default function Home() {
  const config = getHarnessConfig();
  const readiness = [
    { label: "LLM key", ready: Boolean(config.openaiApiKey || config.anthropicApiKey) },
    { label: "GitHub target", ready: Boolean(config.githubOwner && config.githubRepo && config.githubToken) },
    { label: "Vercel preview", ready: Boolean(config.vercelProjectUrl) },
    { label: "Admin token", ready: config.adminTokenConfigured }
  ];

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Self-improving app harness</p>
        <h1>Turn missions into reviewed, validated product changes.</h1>
        <p className="lede">
          Auto App is a Vercel-ready starter that treats self-improvement as a product feature: ideas become plans,
          plans become pull requests, and previews are validated before anything reaches production.
        </p>
        <div className="heroActions">
          <IdeaConsole />
          <a className="adminLink" href="/admin">Open admin control plane</a>
        </div>
      </section>

      <section className="panelGrid" aria-label="Harness details">
        <article className="panel">
          <h2>Built-in loop</h2>
          <ol>
            {workflow.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </article>
        <article className="panel">
          <h2>Readiness</h2>
          <ul className="readiness">
            {readiness.map((item) => (
              <li key={item.label} className={item.ready ? "ready" : "blocked"}>
                <span>{item.ready ? "Ready" : "Missing"}</span>
                {item.label}
              </li>
            ))}
          </ul>
        </article>
        <article className="panel">
          <h2>Safety gates</h2>
          <p>
            The harness is intentionally conservative: dry-run is the default, high-risk ideas need human approval, and
            every generated change must pass typecheck, build, tests, and preview validation before merge.
          </p>
        </article>
      </section>
    </main>
  );
}
