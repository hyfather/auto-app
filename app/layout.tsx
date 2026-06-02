import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoApp — Light Landing Page Refresh",
  description: "A bright, SEO-focused product landing page for founders and teams that need clear positioning, mission-specific CTAs, and demo-ready copy without generated video.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
