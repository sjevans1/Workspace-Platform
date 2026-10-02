import { BlockNoteSchema } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";

// One app-owned schema is used by browser collaboration and the Node.js
// ServerBlockNoteEditor projection. Do not introduce client-only block types.
const callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      variant: {
        default: "info" as const,
        values: ["info", "warning", "success"] as const,
      },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => (
      <aside className="workspace-callout"
        data-workspace-callout={block.props.variant}>
        <span className="workspace-callout-icon" contentEditable={false}
          aria-hidden="true">ⓘ</span>
        <div className="workspace-callout-content" ref={contentRef} />
      </aside>
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <aside data-workspace-callout={block.props.variant}>
        <div ref={contentRef} />
      </aside>
    ),
    parse: (element) => {
      if (element.tagName !== "ASIDE" ||
        !element.hasAttribute("data-workspace-callout")) return undefined;
      const variant = element.getAttribute("data-workspace-callout");
      return {
        variant: variant === "warning" || variant === "success"
          ? variant : "info" as const,
      };
    },
  },
)();

const divider = createReactBlockSpec(
  {
    type: "divider",
    propSchema: {},
    content: "none",
  },
  {
    render: () => (
      <div className="workspace-divider" data-workspace-divider="true"
        contentEditable={false} aria-label="Section divider">
        <hr />
      </div>
    ),
    toExternalHTML: () => (
      <div data-workspace-divider="true"><hr /></div>
    ),
    parse: (element) => element.getAttribute("data-workspace-divider") === "true"
      ? {} : undefined,
  },
)();

// extend() retains every existing default BlockNote Core block and style.
export const workspaceEditorSchema = BlockNoteSchema.create().extend({
  blockSpecs: { callout, divider },
});
