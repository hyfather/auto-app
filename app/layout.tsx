import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoApp - Light Background App Builder",
  description: "AutoApp turns Slack missions into polished public Next.js apps with clear light-background landing pages, focused calls to action, and human-approved improvements.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
