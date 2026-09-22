import type { Metadata } from "next";
import "./globals.css";

/**
 * Fonts come from a single Google Fonts `css2` link, exactly as the artboards
 * declare them: Plus Jakarta Sans for UI, Newsreader for editorial text,
 * JetBrains Mono for ids, hashes, scopes and logs. Fallbacks (system-ui,
 * Georgia, monospace) are set alongside the families in globals.css.
 */
const GOOGLE_FONTS =
  "https://fonts.googleapis.com/css2" +
  "?family=JetBrains+Mono:wght@400;500" +
  "&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600" +
  "&family=Plus+Jakarta+Sans:wght@400;500;600;700" +
  "&display=swap";

export const metadata: Metadata = {
  title: "Formic",
  description:
    "An autonomous agent Kanban platform that orchestrates software builds from backlog idea to merged PR.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={GOOGLE_FONTS} />
      </head>
      <body className="bg-cream text-ink min-h-dvh">{children}</body>
    </html>
  );
}
