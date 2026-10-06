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
export type WorkspaceTemplate = {
  title: string;
  description: string;
  icon: string;
  kind: "page" | "database" | "space";
  blocks?: any[];
  tasks?: boolean;
  children?: Array<{
    kind: "page" | "database";
    title: string;
    icon?: string;
    template?: string;
  }>;
};
const pageTemplate = (
  title: string,
  description: string,
  icon: string,
  headings: string[],
): WorkspaceTemplate => ({
  title, description, icon, kind: "page",
  blocks: headings.flatMap((text) => [
    { type: "heading", props: { level: 2 }, content: text },
    { type: "paragraph", content: "Add the details your team needs." },
  ]),
});
export const templates: Record<string, WorkspaceTemplate> = {
  blank: pageTemplate(
    "Blank page", "A little space for your next idea.", "✧", [],
  ),
  meeting: pageTemplate(
    "Meeting notes", "Turn conversations into clear next steps.", "☷",
    ["Agenda", "Decisions", "Next steps"],
  ),
  project: pageTemplate(
    "Project plan", "Keep milestones and decisions together.", "◈",
    ["Purpose", "Milestones", "Risks and decisions"],
  ),
  knowledge: pageTemplate(
    "Knowledge base", "Build a useful home for shared knowledge.", "📖",
    ["Start here", "Useful links"],
  ),
  sop: pageTemplate(
    "Standard procedure", "Document a repeatable way of working.", "↳",
    ["Purpose and scope", "Procedure", "Review"],
  ),
  decision: pageTemplate(
    "Decision log", "Remember the why behind the what.", "◎",
    ["Decision", "Evidence and alternatives", "Owner and follow-up"],
  ),
  tasks: {
    title: "Task tracker",
    description: "A table and board to keep work moving.",
    icon: "☑",
    kind: "database",
    tasks: true,
  },
  "project-space": {
    title: "Project space",
    description: "A ready-made home for a project, decisions and delivery.",
    icon: "◈",
    kind: "space",
    children: [
      { kind: "page", title: "Project plan", icon: "◈", template: "project" },
      { kind: "database", title: "Tasks", icon: "☑", template: "tasks" },
      { kind: "page", title: "Decision log", icon: "◎", template: "decision" },
    ],
  },
};

