import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  linkedWorkspaceResources,
  workspacePageHref,
} from "../packages/editor/links.ts";

test("links: only canonical relative BlockNote page links count", () => {
  const target = randomUUID(), other = randomUUID();
  const real = workspacePageHref(target);
  assert.equal(real, "/?page=" + target);
  const blocks = [
    {
      type: "paragraph",
      content: [
        { type: "link", href: real, content: [{ type: "text", text: "Page", styles: {} }] },
        { type: "link", href: real, content: "Duplicate" },
        { type: "text", text: "plain text ?page=" + other, styles: {} },
        { type: "link", href: "https://evil.test/?page=" + other, content: "External" },
        { type: "link", href: "/?page=" + other + "&redirect=evil", content: "Params" },
      ],
    },
    {
      type: "bulletListItem",
      content: [],
      children: [
        { type: "paragraph", content: [
          { type: "link", href: "?page=" + other, content: "Nested" },
        ] },
      ],
    },
  ];
  assert.deepEqual(
    [...linkedWorkspaceResources(blocks)].sort(),
    [target, other].sort(),
  );
  assert.deepEqual([...linkedWorkspaceResources([
    { type: "paragraph", content: "Some plain text " + real },
  ])], []);
  assert.deepEqual([...linkedWorkspaceResources([
    { type: "paragraph", props: { hidden: { type: "link", href: real } }, content: [] },
  ])], []);
  assert.throws(() => workspacePageHref("not-uuid"), /Invalid/);
});
