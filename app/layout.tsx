import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoApp — The Self-Improving App Builder",
  description: "Build elegant web apps that evolve from Slack. Control the brain via Slack, let users experience the polished UI on Vercel. Powered by shadcn/ui, Next.js, and continuous human-approved improvements.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
