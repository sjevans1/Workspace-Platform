import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { workspaceEditorSchema } from "./schema.tsx";
import * as Y from "yjs";
import { textOf, assert } from "../contracts/index.ts";
const editor = ServerBlockNoteEditor.create({ schema: workspaceEditorSchema });
export const fragment = "document";
export function validateBlocks(blocks: unknown): asserts blocks is any[] {
  assert(
    Array.isArray(blocks) && JSON.stringify(blocks).length < 4194304,
    400,
    "Invalid or oversized document",
  );
  const check = (v: any, d = 0) => {
    assert(d < 40, 400, "Document nesting too deep");
    if (Array.isArray(v)) return v.forEach((x) => check(x, d + 1));
    if (v && typeof v === "object") {
      if (v.type === "callout") {
        const variant = v.props?.variant ?? "info";
        assert(["info", "warning", "success"].includes(variant), 400,
          "Invalid callout variant");
      }
      if (v.type === "divider")
        assert(!v.content || (Array.isArray(v.content) &&
          v.content.length === 0), 400, "Divider cannot contain text");
      for (const [k, x] of Object.entries(v)) {
        assert(
          !["__proto__", "constructor", "prototype"].includes(k),
          400,
          "Unsafe property",
        );
        if (["href", "url"].includes(k) && typeof x === "string" && x)
          assert(
            /^https?:\/\//i.test(x) ||
              /^mailto:/i.test(x) ||
              /^\/api\/v1\/files\/[a-f0-9-]+\/content$/.test(x) ||
              /^\/?\?page=[a-f0-9-]+$/.test(x),
            400,
            "Unsafe link",
          );
        check(x, d + 1);
      }
    }
  };
  check(blocks);
}
export function blocksToState(blocks: any[]) {
  validateBlocks(blocks);
  const d = editor.blocksToYDoc(
    blocks.length ? blocks : [{ type: "paragraph", content: [] }],
    fragment,
  );
  const state = Buffer.from(Y.encodeStateAsUpdate(d));
  d.destroy();
  return state;
}
export function project(d: Y.Doc) {
  const blocks = editor.yDocToBlocks(d, fragment);
  validateBlocks(blocks);
  return {
    blocks,
    plain_text: textOf(blocks).replace(/\s+/g, " ").trim(),
    state: Buffer.from(Y.encodeStateAsUpdate(d)),
  };
}
export async function markdownToBlocks(md: string) {
  const b = await editor.tryParseMarkdownToBlocks(md);
  validateBlocks(b);
  return b;
}
export const blocksToMarkdown = (b: any[]) => editor.blocksToMarkdownLossy(b);
export const templates: Record<string, { title: string; blocks: any[] }> =
  Object.fromEntries(
    [
      ["blank", "Blank Page", []],
      ["meeting", "Meeting Notes", ["Agenda", "Decisions", "Next steps"]],
      ["project", "Project", ["Purpose", "Milestones", "Risks and decisions"]],
      ["knowledge", "Knowledge Base", ["Start here", "Useful links"]],
      ["sop", "SOP", ["Purpose and scope", "Procedure", "Review"]],
      [
        "decision",
        "Decision Log",
        ["Decision", "Evidence and alternatives", "Owner and follow-up"],
      ],
    ].map(([id, title, headings]) => [
      id,
      {
        title,
        blocks: (headings as string[]).flatMap((text) => [
          { type: "heading", props: { level: 2 }, content: text },
          { type: "paragraph", content: "Add the details your team needs." },
        ]),
      },
    ]),
  ) as any;
