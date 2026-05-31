import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoApp",
  description: "A Slack-native autonomous app builder and operator.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
