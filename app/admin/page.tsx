import { AdminConsole } from "./admin-console";

const adminFeatures = [
  "Bearer-token protected admin APIs for listing, creating, approving, rejecting, dispatching, validating, and merging improvement runs.",
  "Policy triage that marks risk, approval requirements, and blocking reasons before implementation starts.",
  "Audit events for creation, triage, approval, rejection, dispatch, validation, merge blocks, and agent-loop generated work.",
  "A dry-run agent loop that converts mission and metrics signals into reviewable improvement runs."
];

export default function AdminPage() {
  return (
    <main className="shell">
      <section className="hero compactHero">
        <p className="eyebrow">Admin + agentic control plane</p>
        <h1>Govern autonomous improvements before they touch code.</h1>
        <p className="lede">
          This console is intentionally operator-first: every agentic suggestion becomes an auditable improvement run,
          and risky work remains gated behind explicit admin approval.
        </p>
      </section>

      <section className="panelGrid" aria-label="Admin features">
        {adminFeatures.map((feature) => (
          <article className="panel" key={feature}>
            <p>{feature}</p>
          </article>
        ))}
      </section>

      <AdminConsole />
    </main>
  );
}
