import type { ReactNode } from "react";
import "./globals.css";
import "@blocknote/core/fonts/inter.css";
export const metadata = {
  title: "Workspace",
  description: "A shared home for knowledge, projects and decisions.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
