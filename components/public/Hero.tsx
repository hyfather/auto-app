import { CTA } from "./CTA";

type HeroProps = { missionTitle?: string | null };
function copyForMission(mission?: string | null) {
  const text = mission || "Give AutoApp a mission in Slack #general.";
  if (/light\s*(background|mode|theme)|bright|day\s*mode|instead of dark/i.test(text)) return { headline: "A bright, light landing page that feels welcoming.", lead: "AutoApp has reworked this page with a clean light background—high-contrast text, airy spacing, and a fresh palette—so visitors get a calm, modern first impression.", primary: "See the light theme", secondary: "Explore the offer", eyebrow: "For teams who want a clean, light, modern site" };
  if (/auto.?merge|cursor.*(pr|pull request)|merge.*(check|pass)|checks?.*(pass|green)/i.test(text)) return { headline: "Auto-merge Cursor PRs the moment every GitHub check passes.", lead: "AutoApp lets Cursor open pull requests that merge themselves automatically once all required GitHub status checks go green—no manual babysitting, no stale branches, no waiting on a human to click merge.", primary: "Enable auto-merge", secondary: "See how it works", eyebrow: "For engineering teams shipping with Cursor and GitHub" };
  if (/self.?improv|perfect.*app|elegant.*ux|shadcn/i.test(text)) return { headline: "The app that builds itself—one PR at a time.", lead: "A self-improving web app with an elegant shadcn-based UI. Control the brain from Slack, and let your users experience the polished result on Vercel.", primary: "See how it works", secondary: "Explore the offer" };
  if (/book|author|novel|ebook/i.test(text)) return { headline: "Turn your book into a focused sales page.", lead: "AutoApp is shaping this public site into a persuasive book landing page with clear positioning, purchase paths, and trust-building sections.", primary: "Buy the book", secondary: "Read a sample" };
  if (/beta|signup|waitlist|sign up/i.test(text)) return { headline: "Collect beta signups with a clearer promise.", lead: "AutoApp is tuning this page around a crisp value proposition, simple signup flow, and proof that helps visitors join with confidence.", primary: "Join the beta", secondary: "See the offer" };
  if (/local|service|booking|appointment/i.test(text)) return { headline: "Help local customers understand and book your service.", lead: "AutoApp is adapting this public page for service details, local trust signals, and a direct path to request help.", primary: "Request service", secondary: "View details" };
  return { headline: text, lead: "AutoApp continuously improves this Vercel-deployed app from Slack, one human-approved PR-sized improvement at a time.", primary: "Start with the mission", secondary: "See the offer" };
}
export function Hero({ missionTitle }: HeroProps) {
  const copy = copyForMission(missionTitle);
  return <section className="hero"><div><p className="eyebrow">{("eyebrow" in copy && copy.eyebrow) || "For teams \u0026 builders who want apps that evolve"}</p><h1>{copy.headline}</h1><p className="lead">{copy.lead}</p><CTA primary={copy.primary} secondary={copy.secondary} /></div><aside className="card"><h2>Current mission</h2><p>{missionTitle || "Give AutoApp a mission in Slack #general."}</p><p className="built">One Slack channel. One mission. One deployed app. Continuous, PR-sized improvements.</p></aside></section>;
}
