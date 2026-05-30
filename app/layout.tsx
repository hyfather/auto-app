import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Auto App",
  description: "A Vercel-ready self-improving application harness."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
