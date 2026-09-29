"use client";
import { useEffect, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api, notify } from "../lib/api";
function Body({
  provider,
  doc,
  user,
  id,
  readOnly,
}: {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  user: any;
  id: string;
  readOnly: boolean;
}) {
  const editor = useCreateBlockNote({
    collaboration: {
      provider,
      fragment: doc.getXmlFragment("document"),
      user: { name: user.name, color: "#287661" },
    },
    uploadFile: async (file) => {
      const data = new FormData();
      data.append("file", file);
      return (await api(`/resources/${id}/files`, "POST", data)).url;
    },
  });
  return <BlockNoteView editor={editor} editable={!readOnly} theme="light" />;
}
export default function Editor({ id, user }: { id: string; user: any }) {
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
            setConnection({ provider: p, doc, readOnly: ticket.readOnly });
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
        <Body {...connection} user={user} id={id} />
      ) : (
        <div className="loading">Opening document…</div>
      )}
    </>
  );
}
