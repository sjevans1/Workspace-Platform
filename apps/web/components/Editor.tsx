"use client";
import { useEffect, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api, notify } from "../lib/api";
import { workspacePageHref } from "../../../packages/editor/links";
import { workspaceEditorSchema } from "../../../packages/editor/schema";
function Body({
  provider,
  doc,
  user,
  id,
  readOnly,
  theme,
}: {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  user: any;
  id: string;
  readOnly: boolean;
  theme: "light" | "dark";
}) {
  const [picker, setPicker] = useState(false),
    [needle, setNeedle] = useState(""),
    [suggestions, setSuggestions] = useState<any[]>([]),
    [searching, setSearching] = useState(false);
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: workspaceEditorSchema,
      collaboration: {
        provider: { awareness: provider.awareness || undefined },
        fragment: doc.getXmlFragment("document"),
        user: { name: user.name, color: "#287661" },
      },
      uploadFile: async (file: File) => {
        const data = new FormData();
        data.append("file", file);
        return (await api(`/resources/${id}/files`, "POST", data)).url;
      },
    }),
    [doc, provider],
  );
  async function findPages(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const query = needle.trim();
    if (!query) return setSuggestions([]);
    setSearching(true);
    try {
      const results = await api("/search?q=" + encodeURIComponent(query));
      setSuggestions(results.filter((entry: any) =>
        ["page", "record"].includes(entry.kind) && entry.id !== id,
      ).slice(0, 20));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Page search failed");
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }
  function changeBlock(kind: "paragraph" | "heading" | "bulletListItem" | "numberedListItem") {
    if (readOnly) return;
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, kind === "heading"
      ? { type: "heading", props: { level: 2 } }
      : { type: kind });
    editor.focus();
  }
  function insertRichBlock(type: "callout" | "divider") {
    if (readOnly) return;
    const active = editor.getTextCursorPosition().block;
    if (type === "callout") {
      const inserted = editor.insertBlocks([{
        type: "callout", props: { variant: "info" },
        content: "Add a note for your team.",
      }], active, "after");
      // insertBlocks does not automatically move the cursor. Leave it at
      // the new inline-capable block so the next inserted divider appears
      // *after* the callout rather than unexpectedly before it.
      editor.setTextCursorPosition(inserted[0], "end");
    } else {
      editor.insertBlocks([{ type: "divider" }], active, "after");
    }
    editor.focus();
  }
  function toggleMark(mark: "bold" | "italic") {
    if (readOnly) return;
    if (mark === "bold") editor.toggleStyles({ bold: true });
    else editor.toggleStyles({ italic: true });
    editor.focus();
  }
  function insertPageLink(page: any) {
    if (readOnly) return;
    editor.focus();
    editor.createLink(workspacePageHref(page.id), page.title);
    setPicker(false);
    setNeedle("");
    setSuggestions([]);
    notify("Page link inserted");
  }
  return (
    <>
      {!readOnly && (
        <div className="page-link-tools editor-format-tools"
          role="toolbar" aria-label="Formatting">
          <button type="button" className="button small-button"
            aria-label="Bold selection" title="Toggle bold"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark("bold")}>Bold</button>
          <button type="button" className="button small-button"
            aria-label="Italic selection" title="Toggle italic"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark("italic")}>Italic</button>
          <button type="button" className="button small-button"
            aria-label="Heading 2" title="Convert active block to heading"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("heading")}>H2</button>
          <button type="button" className="button small-button"
            aria-label="Bulleted list" title="Convert active block to bullets"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("bulletListItem")}>Bullets</button>
          <button type="button" className="button small-button"
            aria-label="Numbered list" title="Convert active block to numbered list"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("numberedListItem")}>Numbers</button>
          <button type="button" className="button small-button"
            aria-label="Paragraph" title="Convert active block to paragraph"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("paragraph")}>Text</button>
          <button type="button" className="button small-button"
            aria-label="Insert callout" title="Insert an editable callout"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertRichBlock("callout")}>Callout</button>
          <button type="button" className="button small-button"
            aria-label="Insert divider" title="Insert a section divider"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertRichBlock("divider")}>Divider</button>
        </div>
      )}
      {!readOnly && (
        <div className="page-link-tools">
          <button type="button" className="button small-button"
            aria-expanded={picker} aria-controls="page-link-picker"
            onClick={() => { setPicker((v) => !v); setSuggestions([]); }}>
            Link to page
          </button>
          {picker && (
            <form id="page-link-picker" className="page-link-picker" onSubmit={findPages}>
              <label htmlFor="page-link-search">Find a page to link</label>
              <div className="page-link-search-row">
                <input id="page-link-search" aria-label="Find a page to link"
                  value={needle} onChange={(e) => setNeedle(e.target.value)}
                  placeholder="Search accessible pages" required />
                <button className="button" disabled={searching}>
                  {searching ? "Searching…" : "Find"}
                </button>
                <button type="button" className="button"
                  onClick={() => setPicker(false)}>Cancel</button>
              </div>
              <div className="page-link-results" aria-live="polite">
                {suggestions.map((item: any) => (
                  <button key={item.id} type="button" className="page-link-choice"
                    onClick={() => insertPageLink(item)}>
                    {item.title}
                  </button>
                ))}
                {!searching && needle.trim() && !suggestions.length && (
                  <span className="muted">Search for a page you can access.</span>
                )}
              </div>
            </form>
          )}
        </div>
      )}
      <BlockNoteView editor={editor} editable={!readOnly} theme={theme} />
    </>
  );
}
export default function Editor({ id, user, theme }: { id: string; user: any; theme: "light" | "dark" }) {
  const [connection, setConnection] = useState<any>(),
    [status, setStatus] = useState("Connecting…"),
    [people, setPeople] = useState<string[]>([]),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    let disposed = false,
      p: HocuspocusProvider | undefined;
    const doc = new Y.Doc();
    let persisted: Y.Snapshot | undefined,
      connected = false;
    const update = () =>
      setStatus(
        connected
          ? persisted && Y.equalSnapshots(persisted, Y.snapshot(doc))
            ? "Saved"
            : "Saving…"
          : "Offline · changes are not saved",
      );
    doc.on("update", update);
    api(`/pages/${id}/collab`, "POST", {})
      .then((ticket) => {
        if (disposed) return;
        let readOnly = ticket.readOnly;
        const url =
          process.env.NEXT_PUBLIC_COLLAB_URL ||
          (location.port === "3000"
            ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:1234`
            : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collaboration`);
        p = new HocuspocusProvider({
          url,
          name: ticket.name,
          token: () =>
            api(`/pages/${id}/collab`, "POST", {}).then((t) => t.token),
          document: doc,
          onStatus: ({ status: s }) => {
            connected = s === "connected";
            update();
          },
          onSynced: () => {
            if (disposed) return;
            setConnection({ provider: p, doc, readOnly });
            p?.sendStateless("status");
          },
          onStateless: ({ payload }) => {
            const v = JSON.parse(payload);
            if (v.type === "persisted") {
              persisted = Y.decodeSnapshot(
                Uint8Array.from(atob(v.snapshot), (c) => c.charCodeAt(0)),
              );
              update();
            }
            if (v.type === "persistence-error")
              setStatus("Save failed · keep this page open");
            if (v.type === "permission") {
              readOnly = v.readOnly;
              setConnection((current: any) =>
                current ? { ...current, readOnly } : current,
              );
            }
            if (v.type === "reset") {
              setConnection(undefined);
              setGeneration((x) => x + 1);
            }
          },
          onAuthenticationFailed: () =>
            setStatus("Access changed · refresh to continue"),
          onAwarenessChange: ({ states }) =>
            setPeople([
              ...new Set(states.map((s: any) => s.user?.name).filter(Boolean)),
            ] as string[]),
        });
      })
      .catch((e) => {
        setStatus("Unable to connect");
        notify(e.message);
      });
    return () => {
      disposed = true;
      setConnection(undefined);
      p?.destroy();
      doc.destroy();
    };
  }, [id, generation]);
  return (
    <>
      <div className="editor-state">
        <div className="presence">
          {people.slice(0, 4).map((n) => (
            <span className="avatar small" key={n} title={n}>
              {n.slice(0, 1)}
            </span>
          ))}
        </div>
        <span
          className={status === "Saved" ? "saved" : "muted"}
          role="status"
          aria-live="polite"
        >
          {status === "Saved" ? "✓ " : ""}
          {status}
        </span>
      </div>
      {connection ? (
        <Body {...connection} user={user} id={id} theme={theme} />
      ) : (
        <div className="loading">Opening document…</div>
      )}
    </>
  );
}
