import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoApp — Light Landing Pages Improved from Slack",
  description: "AutoApp helps founders and product teams ship bright, responsive Next.js landing pages with mission-aware copy, Slack-controlled approvals, and human-reviewed PRs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
