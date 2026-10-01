// Workspace page references are ordinary BlockNote links. We intentionally
// accept only relative, canonical Workspace paths: external URLs and text that
// happens to contain a UUID must never become an internal backlink.
const pageHref = /^\/?\?page=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function workspacePageHref(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Invalid Workspace resource ID");
  return "/?page=" + id.toLowerCase();
}

export function linkedWorkspaceResources(blocks: unknown): Set<string> {
  const links = new Set<string>();
  function walk(value: unknown, depth: number) {
    if (depth > 40 || !value) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (v.type === "link" && typeof v.href === "string") {
      const match = pageHref.exec(v.href);
      if (match) links.add(match[1].toLowerCase());
    }
    // Inspect content trees and table cells, never arbitrary metadata.
    for (const property of ["content", "children", "rows", "cells"])
      walk(v[property], depth + 1);
  }
  walk(blocks, 0);
  return links;
}
