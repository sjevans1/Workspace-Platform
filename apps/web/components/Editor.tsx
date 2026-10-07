"use client";
import { useEffect, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api, notify } from "../lib/api";
import {
  clearWorkspaceDraft,
  loadWorkspaceDraft,
  saveWorkspaceDraft,
  type WorkspaceDraftIdentity,
} from "../lib/recovery-drafts";
import { workspacePageHref } from "../../../packages/editor/links";
import { workspaceEditorSchema } from "../../../packages/editor/schema";
function Body({
  provider,
  doc,
  user,
  id,
  readOnly,
  theme,
  commentable,
  onCommentBlock,
}: {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  user: any;
  id: string;
  readOnly: boolean;
  theme: "light" | "dark";
  commentable: boolean;
  onCommentBlock: (blockId: string) => void;
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
      const result = await api("/search?q=" + encodeURIComponent(query));
      setSuggestions(result.items.filter((entry: any) =>
        ["page", "record"].includes(entry.kind) && entry.id !== id,
      ).slice(0, 20));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Page search failed");
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }
  function changeBlock(
    kind: "paragraph" | "heading" | "bulletListItem" | "numberedListItem" | "checkListItem",
    level: 1 | 2 | 3 = 2,
  ) {
    if (readOnly) return;
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, kind === "heading"
      ? { type: "heading", props: { level } }
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
  // Pointer activation is a two-stage operation: an incoming peer edit may
  // remap the ProseMirror selection between mouse-down and click. Preserve
  // the exact block the user chose, never a different live cursor neighbor.
  const structuralTarget = useRef<string | null>(null);
  const pointedBlock = useRef<string | null>(null);
  const commentTarget = useRef<string | null>(null);
  const pendingStructural = useRef(new Map<string, (ok: boolean, reason?: string) => void>());
  useEffect(() => {
    const onStateless = ({ payload }: { payload: string }) => {
      let message: { type?: string; requestId?: string; reason?: string };
      try { message = JSON.parse(payload); } catch { return; }
      if (message.type !== "structural.granted" &&
          message.type !== "structural.denied") return;
      const pending = pendingStructural.current.get(message.requestId || "");
      if (!pending) return;
      pendingStructural.current.delete(message.requestId || "");
      pending(message.type === "structural.granted", message.reason);
    };
    provider.on("stateless", onStateless);
    const pending=pendingStructural.current;
    return () => {
      provider.off("stateless", onStateless);
      for(const finish of pending.values())finish(false,"disconnected");
      pending.clear();
    };
  }, [provider]);
  async function reserveStructural(blockId: string): Promise<boolean> {
    const vector=Y.encodeStateVector(doc);
    if (vector.length > 3072) {
      notify("This document needs resynchronization before moving blocks.");
      return false;
    }
    const requestId=crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer=setTimeout(()=>{
        pendingStructural.current.delete(requestId);
        notify("Could not verify a safe structural edit. Try again.");
        resolve(false);
      },4000);
      pendingStructural.current.set(requestId,(ok,reason)=>{
        clearTimeout(timer);
        if(!ok)notify(reason === "concurrent-edit"
          ? "Another editor is changing this block. Retry after it settles."
          : "The page changed. Select the block again before editing.");
        resolve(ok);
      });
      try {
        provider.sendStateless(JSON.stringify({
          type:"structural.acquire",requestId,blockId,
          vector:btoa(String.fromCharCode(...vector)),
        }));
      } catch {
        clearTimeout(timer);
        pendingStructural.current.delete(requestId);
        notify("Collaboration connection unavailable.");
        resolve(false);
      }
    });
  }
  function rememberCommentTarget() {
    commentTarget.current =
      pointedBlock.current || editor.getTextCursorPosition().block.id;
  }
  function commentOnBlock() {
    const target = commentTarget.current ||
      editor.getTextCursorPosition().block.id;
    commentTarget.current = null;
    if (!editor.getBlock(target)) {
      notify("This block changed in another session. Select it again.");
      return;
    }
    onCommentBlock(target);
  }
  function rememberStructuralTarget() {
    // The editor pointer event happens when the user actually picks the
    // block. A remote Yjs update may rebase the live cursor before the
    // formatting-toolbar mouse-down, so prefer this earlier, stable ID.
    structuralTarget.current =
      pointedBlock.current || editor.getTextCursorPosition().block.id;
  }
  async function structuralAction(action: "up" | "down" | "delete") {
    if (readOnly) return;
    const target =
      structuralTarget.current || editor.getTextCursorPosition().block.id;
    structuralTarget.current = null;
    pointedBlock.current = null;
    // In single-writer mode the Hocuspocus server arbitrates competing
    // actions on exactly the same block. Refuse a stale state vector instead
    // of allowing a remote move to retarget a local delete to its neighbor.
    if (!(await reserveStructural(target))) return;
    if (!editor.getBlock(target)) {
      notify("This block changed in another session. Select it again.");
      return;
    }
    if (action === "up") editor.moveBlocksUp(target);
    else if (action === "down") editor.moveBlocksDown(target);
    else editor.removeBlocks([target]);
    editor.focus();
  }
  function toggleMark(mark: "bold" | "italic" | "underline") {
    if (readOnly) return;
    if (mark === "bold") editor.toggleStyles({ bold: true });
    else if (mark === "italic") editor.toggleStyles({ italic: true });
    else editor.toggleStyles({ underline: true });
    editor.focus();
  }
  function historyAction(action: "undo" | "redo") {
    if (readOnly) return;
    // Work through the editor's collaboration-aware history; never replace
    // canonical blocks from plain text or mutate the Yjs document manually.
    if (action === "undo") editor.undo();
    else editor.redo();
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
            aria-label="Underline selection" title="Toggle underline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleMark("underline")}>Underline</button>
          <button type="button" className="button small-button"
            aria-label="Heading 1" title="Convert active block to heading level 1"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("heading", 1)}>H1</button>
          <button type="button" className="button small-button"
            aria-label="Heading 2" title="Convert active block to heading"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("heading")}>H2</button>
          <button type="button" className="button small-button"
            aria-label="Heading 3" title="Convert active block to heading level 3"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("heading", 3)}>H3</button>
          <button type="button" className="button small-button"
            aria-label="Bulleted list" title="Convert active block to bullets"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("bulletListItem")}>Bullets</button>
          <button type="button" className="button small-button"
            aria-label="Numbered list" title="Convert active block to numbered list"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("numberedListItem")}>Numbers</button>
          <button type="button" className="button small-button"
            aria-label="Checklist" title="Convert active block to checklist"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeBlock("checkListItem")}>Checklist</button>
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
          <button type="button" className="button small-button"
            aria-label="Move current block up" title="Move selected block up"
            onMouseDown={(e) => { e.preventDefault(); rememberStructuralTarget(); }}
            onClick={() => structuralAction("up")}>Move up</button>
          <button type="button" className="button small-button"
            aria-label="Move current block down" title="Move selected block down"
            onMouseDown={(e) => { e.preventDefault(); rememberStructuralTarget(); }}
            onClick={() => structuralAction("down")}>Move down</button>
          <button type="button" className="button small-button"
            aria-label="Delete current block" title="Delete selected block (Undo restores)"
            onMouseDown={(e) => { e.preventDefault(); rememberStructuralTarget(); }}
            onClick={() => structuralAction("delete")}>Delete block</button>
          <button type="button" className="button small-button"
            aria-label="Undo last edit" title="Undo recent local change"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => historyAction("undo")}>Undo</button>
          <button type="button" className="button small-button"
            aria-label="Redo last edit" title="Redo recent local change"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => historyAction("redo")}>Redo</button>
        </div>
      )}
      {commentable && (
        <div className="page-link-tools" role="group" aria-label="Block discussion">
          <button type="button" className="button small-button"
            aria-label="Comment on selected block"
            onMouseDown={(event) => {
              event.preventDefault();
              rememberCommentTarget();
            }}
            onClick={commentOnBlock}>
            Comment on block
          </button>
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
      <div
        onPointerDownCapture={(event) => {
          if (!(event.target instanceof Element)) return;
          const block = event.target.closest<HTMLElement>(".bn-block[data-id]");
          pointedBlock.current = block?.dataset.id || null;
        }}
        onKeyDownCapture={() => {
          // Keyboard navigation, including Arrow keys, supersedes the last
          // pointer selection. The toolbar then uses the live cursor.
          pointedBlock.current = null;
        }}
      >
        <BlockNoteView editor={editor} editable={!readOnly} theme={theme} />
      </div>
    </>
  );
}
export default function Editor({
  id, user, theme, commentable = false, onCommentBlock,
}: {
  id: string;
  user: any;
  theme: "light" | "dark";
  commentable?: boolean;
  onCommentBlock: (blockId: string) => void;
}) {
  const [connection, setConnection] = useState<any>(),
    [status, setStatus] = useState("Connecting…"),
    [people, setPeople] = useState<string[]>([]),
    [generation, setGeneration] = useState(0),
    [recovery, setRecovery] = useState<{
      identity: WorkspaceDraftIdentity;
      updatedAt: number;
      restore: () => void;
      discard: () => void;
    }>();
  useEffect(() => {
    let disposed = false,
      p: HocuspocusProvider | undefined;
    const doc = new Y.Doc();
    let persisted: Y.Snapshot | undefined,
      connected = false,
      readOnly = true,
      identity: WorkspaceDraftIdentity | undefined,
      pendingRecovery = false,
      draftTimer: ReturnType<typeof setTimeout> | undefined,
      recoveryWarningShown = false;

    const statusFromState = () =>
      connected
        ? persisted && Y.equalSnapshots(persisted, Y.snapshot(doc))
          ? "Saved"
          : "Saving…"
        : "Offline · changes are not saved";

    const persistLocalRecovery = () => {
      if (
        disposed ||
        !identity ||
        readOnly ||
        !persisted ||
        Y.equalSnapshots(persisted, Y.snapshot(doc))
      )
        return;
      const saved = saveWorkspaceDraft(identity, Y.encodeStateAsUpdate(doc));
      if (saved.ok) {
        if (!connected) setStatus("Offline · changes saved on this device");
        return;
      }
      if (!recoveryWarningShown) {
        recoveryWarningShown = true;
        notify(
          saved.reason === "too-large"
            ? "This unsaved draft is too large for device recovery. Keep this page open until it is saved."
            : "Device recovery storage is unavailable. Keep this page open until it is saved.",
        );
      }
      if (!connected) setStatus("Offline · keep this page open");
    };

    const update = () => {
      setStatus(statusFromState());
      if (!persisted || readOnly || !identity) return;
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(persistLocalRecovery, 75);
    };
    doc.on("update", update);

    api(`/pages/${id}/collab`, "POST", {})
      .then((ticket) => {
        if (disposed) return;
        readOnly = ticket.readOnly;
        identity = { principal: user.id, room: ticket.name };
        const stored = readOnly ? null : loadWorkspaceDraft(identity);
        if (readOnly) clearWorkspaceDraft(identity);
        pendingRecovery = Boolean(stored);

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
            if (!connected) persistLocalRecovery();
          },
          onSynced: () => {
            if (disposed) return;
            setConnection({ provider: p, doc, readOnly });
            if (stored && pendingRecovery && identity && !readOnly) {
              const recoveryIdentity = identity;
              setRecovery({
                identity: recoveryIdentity,
                updatedAt: stored.updatedAt,
                restore: () => {
                  if (disposed || readOnly) return;
                  pendingRecovery = false;
                  Y.applyUpdate(doc, stored.update, "device-recovery");
                  setRecovery(undefined);
                  persistLocalRecovery();
                },
                discard: () => {
                  pendingRecovery = false;
                  clearWorkspaceDraft(recoveryIdentity);
                  setRecovery(undefined);
                },
              });
            }
            p?.sendStateless("status");
          },
          onStateless: ({ payload }) => {
            const v = JSON.parse(payload);
            if (v.type === "persisted") {
              persisted = Y.decodeSnapshot(
                Uint8Array.from(atob(v.snapshot), (c) => c.charCodeAt(0)),
              );
              if (
                identity &&
                !pendingRecovery &&
                Y.equalSnapshots(persisted, Y.snapshot(doc))
              )
                clearWorkspaceDraft(identity);
              else persistLocalRecovery();
              update();
            }
            if (v.type === "persistence-error") {
              persistLocalRecovery();
              setStatus("Save failed · changes kept on this device");
            }
            if (v.type === "permission") {
              readOnly = v.readOnly;
              if (readOnly && identity) {
                pendingRecovery = false;
                clearWorkspaceDraft(identity);
                setRecovery(undefined);
              }
              setConnection((current: any) =>
                current ? { ...current, readOnly } : current,
              );
            }
            if (v.type === "reset") {
              if (identity) clearWorkspaceDraft(identity);
              pendingRecovery = false;
              setRecovery(undefined);
              setConnection(undefined);
              setGeneration((x) => x + 1);
            }
          },
          onAuthenticationFailed: () => {
            if (identity) clearWorkspaceDraft(identity);
            pendingRecovery = false;
            setRecovery(undefined);
            setStatus("Access changed · refresh to continue");
          },
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
      if (draftTimer) clearTimeout(draftTimer);
      // Preserve an unacknowledged local draft across reload/crash, but never
      // create one without a known persisted server baseline.
      persistLocalRecovery();
      disposed = true;
      setConnection(undefined);
      p?.destroy();
      doc.destroy();
    };
  }, [id, generation, user.id]);
  return (
    <>
      {recovery && (
        <div className="recovery-banner" role="alert">
          <div>
            <strong>Unsaved changes are available from this device.</strong>
            <span>
              Restore them into the current page, or discard this local draft.
            </span>
          </div>
          <div className="recovery-actions">
            <button className="button" onClick={recovery.restore}>
              Restore draft
            </button>
            <button className="button secondary" onClick={recovery.discard}>
              Discard draft
            </button>
          </div>
        </div>
      )}
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
        <Body {...connection} user={user} id={id} theme={theme}
          commentable={commentable} onCommentBlock={onCommentBlock} />
      ) : (
        <div className="loading">Opening document…</div>
      )}
    </>
  );
}
