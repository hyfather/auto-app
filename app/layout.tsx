import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "This Week in SF — Interesting events happening in San Francisco every week",
  description: "A weekly guide to the most interesting events happening across San Francisco—from warehouse art shows to neighborhood pop-ups, hackathons, and one-night-only happenings. New picks every week.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
