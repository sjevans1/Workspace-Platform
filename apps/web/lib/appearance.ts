"use client";
import { useEffect, useState } from "react";

export type Appearance = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
const storageKey = "workspace.appearance.v1";
function isAppearance(value: string | null): value is Appearance {
  return value === "light" || value === "dark" || value === "system";
}

// Purely local display preference. No Workspace API, tenant records, AI
// service, or new deployment component is required.
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (isAppearance(stored)) setAppearance(stored);
    } catch {
      // Private browsing / blocked storage still supports live switching.
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const refresh = () => {
      const resolved: ResolvedTheme =
        appearance === "system"
          ? (media.matches ? "dark" : "light")
          : appearance;
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    refresh();
    try {
      window.localStorage.setItem(storageKey, appearance);
    } catch {
      // Cosmetic preference does not block application use.
    }
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, [appearance, ready]);

  return { appearance, setAppearance, resolvedTheme };
}
