import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@blocknote/core/fonts/inter.css";

// Wave X / X3 (W26): application metadata follows the deployment branding.
//
// The web service runs as a Next server and receives the same deployment
// environment as the API, so the title and icons come from that one deployment
// configuration. This does not create a second branding store: the branding
// schema in packages/branding remains the single source of truth for the
// API-rendered surface, and these are the two values Next metadata can express.
// Neutral standalone assets ship in apps/web/public, so a deployment that sets
// nothing still has an icon.
export function generateMetadata(): Metadata {
  const productName = process.env.PRODUCT_NAME || "Workspace";
  const favicon = process.env.FAVICON || "/icon.svg";
  return {
    title: productName,
    description: "A shared home for knowledge, projects and decisions.",
    icons: { icon: favicon, shortcut: favicon, apple: favicon },
  };
}
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
