import { CTA } from "./CTA";
import { NotifyForm } from "./NotifyForm";

type HeroProps = { missionTitle?: string | null };

export function isLaunchMission(mission?: string | null) {
  return /notif|launch|waitlist|sign\s*-?\s*up|signup|subscrib|email\s*(list|added|notif)|get\s+their\s+email|be\s+notified/i.test(mission || "");
}

function copyForMission(mission?: string | null) {
  const text = mission || "Give AutoApp a mission in Slack #general.";
  if (isLaunchMission(text)) return { headline: "Be the first to know when AutoApp launches.", lead: "AutoApp is almost ready. Add your email and we'll send you a single heads-up the moment it goes live—no spam, no noise, just your invite to the launch.", primary: "Notify me at launch", secondary: "See what's coming", eyebrow: "For early adopters waiting on the launch" };
  if (/light\s*(background|mode|theme)|bright|day\s*mode|instead of dark/i.test(text)) return { headline: "A bright, light landing page that feels welcoming.", lead: "AutoApp has reworked this page with a clean light background—high-contrast text, airy spacing, and a fresh palette—so visitors get a calm, modern first impression.", primary: "See the light theme", secondary: "Explore the offer", eyebrow: "For teams who want a clean, light, modern site" };
  if (/self.?improv|perfect.*app|elegant.*ux|shadcn/i.test(text)) return { headline: "The app that builds itself—one PR at a time.", lead: "A self-improving web app with an elegant shadcn-based UI. Control the brain from Slack, and let your users experience the polished result on Vercel.", primary: "See how it works", secondary: "Explore the offer" };
  if (/book|author|novel|ebook/i.test(text)) return { headline: "Turn your book into a focused sales page.", lead: "AutoApp is shaping this public site into a persuasive book landing page with clear positioning, purchase paths, and trust-building sections.", primary: "Buy the book", secondary: "Read a sample" };
  if (/beta|signup|waitlist|sign up/i.test(text)) return { headline: "Collect beta signups with a clearer promise.", lead: "AutoApp is tuning this page around a crisp value proposition, simple signup flow, and proof that helps visitors join with confidence.", primary: "Join the beta", secondary: "See the offer" };
  if (/local|service|booking|appointment/i.test(text)) return { headline: "Help local customers understand and book your service.", lead: "AutoApp is adapting this public page for service details, local trust signals, and a direct path to request help.", primary: "Request service", secondary: "View details" };
  return { headline: text, lead: "AutoApp continuously improves this Vercel-deployed app from Slack, one human-approved PR-sized improvement at a time.", primary: "Start with the mission", secondary: "See the offer" };
}
export function Hero({ missionTitle }: HeroProps) {
  const copy = copyForMission(missionTitle);
  const launch = isLaunchMission(missionTitle);
  return <section className="hero"><div><p className="eyebrow">{("eyebrow" in copy && copy.eyebrow) || "For teams \u0026 builders who want apps that evolve"}</p><h1>{copy.headline}</h1><p className="lead">{copy.lead}</p><CTA primary={copy.primary} secondary={copy.secondary} primaryHref={launch ? "#notify" : "#offer"} secondaryHref={launch ? "#offer" : "#details"} /></div>{launch ? <aside className="card" id="notify"><h2>Get notified at launch</h2><p>Drop your email below. We&apos;ll store it securely and reach out once—when AutoApp is live and ready for you.</p><NotifyForm source="hero" /></aside> : <aside className="card"><h2>Current mission</h2><p>{missionTitle || "Give AutoApp a mission in Slack #general."}</p><p className="built">One Slack channel. One mission. One deployed app. Continuous, PR-sized improvements.</p></aside>}</section>;
}
