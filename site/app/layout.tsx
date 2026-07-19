import type { Metadata } from "next";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeSensei — Understand it. Then test your knowledge.",
  description:
    "A VS Code extension that creates a grounded repository guide, surfaces safe first contributions, and tests your knowledge with code-aware voice questions.",
  openGraph: {
    title: "CodeSensei — Understand it. Then test your knowledge.",
    description:
      "Turn an unfamiliar repository into a practical guide, then let CodeSensei test your understanding with questions grounded in the source.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "CodeSensei — Understand it. Then test your knowledge.",
    description:
      "A repository guide and voice-driven knowledge test inside VS Code.",
  },
  icons: { icon: "/product-icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
