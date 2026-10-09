"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Star,
  MoreHorizontal,
  MessageSquare,
  History,
  Shield,
  Paperclip,
  Plus,
  ArrowUpRight,
  Link as LinkIcon,
  Activity,
} from "lucide-react";
import {
  api,
  downloadWorkspaceArchive,
  run,
  notify,
  changed,
  go,
  icon,
  date,
} from "../lib/api";
import { Modal, Spinner, Empty, Field, FeatureExample } from "./common";
import Database, { PropertyInput } from "./Database";
const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => <Spinner />,
});
export default function Resource({
  id,
  me,
  onGone,
  create,
  theme,
}: {
  id: string;
  me: any;
  onGone: () => void;
  create: (v: any) => void;
  theme: "light" | "dark";
}) {
  const [node, setNode] = useState<any>(),
    [children, setChildren] = useState<any[]>([]),
    [panel, setPanel] = useState(""),
    [commentAnchor, setCommentAnchor] = useState(""),
    [menu, setMenu] = useState(false),
    [record, setRecord] = useState<any>(),
    [members, setMembers] = useState<any[]>([]),
    [exportingArchive, setExportingArchive] = useState(false);
  async function load() {
    const n = await api(`/resources/${id}`);
    setNode(n);
    if (["space", "workspace"].includes(n.kind))
      setChildren(await api(`/resources?parent_id=${id}&limit=200`));
    if (n.kind === "record") {
      setRecord(await api(`/records/${id}`));
      setMembers(await api("/members"));
    }
  }
  useEffect(() => {
    run(load);
    const fn = () => run(load);
    window.addEventListener("workspace-changed", fn);
    return () => window.removeEventListener("workspace-changed", fn);
  }, [id]);
  useEffect(() => {
    if (node?.id !== id) return;
    // Record an actual human visit once per opened resource, not once per
    // edit/refresh. Failure to record cosmetic history must not block editing.
    void api(`/resources/${id}/bookmark`, "POST", {}).catch(() => {});
  }, [id, node?.id]);
  async function exportArchive() {
    setMenu(false);
    setExportingArchive(true);
    try {
      const queued = await api(
        `/resources/${id}/export/archive/jobs`,
        "POST",
        {},
      );
      notify("Workspace archive export queued.");
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const job = await api(`/jobs/${queued.id}`);
        if (job.status === "failed")
          throw Error(job.result?.error || "Archive export failed");
        if (job.status !== "completed") continue;
        const blob = await downloadWorkspaceArchive(
          `/jobs/${queued.id}/archive`,
        );
        const url = URL.createObjectURL(blob),
          anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${node.title || "workspace"}-archive.zip`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        notify("Workspace archive is ready.");
        return;
      }
      throw Error(`Archive export still running. Job ID: ${queued.id}`);
    } finally {
      setExportingArchive(false);
    }
  }
  if (!node) return <Spinner />;
  const editable = node.effective_permission >= 3;
  const collection = ["space", "workspace"].includes(node.kind);
  return (
    <article
      className={`resource ${node.kind === "database" ? "resource-wide" : ""}`}
    >
      <div className="resource-toolbar">
        <div className="breadcrumbs">
          {node.path.slice(0, -1).map((p: any) => (
            <button key={p.id} onClick={() => go(p.id)}>
              {p.title}
              <span>/</span>
            </button>
          ))}
        </div>
        <div className="resource-actions">
          <button
            className={`icon-button ${node.favourite ? "gold" : ""}`}
            aria-label={node.favourite ? "Remove favourite" : "Add favourite"}
            onClick={() =>
              run(async () => {
                await api(`/resources/${id}/bookmark`, "POST", {
                  favourite: !node.favourite,
                });
                await load();
                changed();
              })
            }
          >
            <Star size={17} fill={node.favourite ? "currentColor" : "none"} />
          </button>
          <button
            className="icon-button"
            aria-label="Comments"
            title="Comments"
            onClick={() => {
              setCommentAnchor("");
              setPanel("comments");
            }}
          >
            <MessageSquare size={17} />
          </button>
          <div className="menu-wrap">
            <button
              className="icon-button"
              aria-label="Page actions"
              onClick={() => setMenu((v) => !v)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menu && (
              <div className="dropdown">
                {[
                  ["permissions", "Manage access", Shield],
                  ["history", "Version history", History],
                  ["activity", "Activity", Activity],
                  ["files", "Attachments", Paperclip],
                ]
                  .filter(
                    ([k]) =>
                      k !== "history" ||
                      (!collection && node.kind !== "database"),
                  )
                  .map(([key, label, Icon]: any) => (
                    <button
                      key={key}
                      onClick={() => {
                        setPanel(key);
                        setMenu(false);
                      }}
                    >
                      <Icon size={15} />
                      {label}
                    </button>
                  ))}
                <button
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(
                        `${location.origin}/?page=${id}`,
                      );
                      notify("Page link copied");
                      setMenu(false);
                    })
                  }
                >
                  <LinkIcon size={15} />
                  Copy link
                </button>
                {!collection && (
                  <>
                    <a
                      href={`/api/v1/resources/${id}/export?format=${node.kind === "database" ? "csv" : "markdown"}`}
                      download
                    >
                      Export {node.kind === "database" ? "CSV" : "Markdown"}
                    </a>
                    <a
                      href={`/api/v1/resources/${id}/export?format=json`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Export JSON
                    </a>
                  </>
                )}
                {node.kind !== "record" && (
                  <button
                    disabled={exportingArchive}
                    onClick={() => run(exportArchive)}
                  >
                    {exportingArchive
                      ? "Preparing workspace archive…"
                      : "Export workspace archive"}
                  </button>
                )}
                {editable && ["page", "database", "space"].includes(node.kind) && (
                  <button
                    onClick={() =>
                      run(async () => {
                        const p = await api(
                          `/resources/${id}/duplicate`,
                          "POST",
                          {},
                        );
                        changed();
                        notify(
                          `Duplicated ${p.duplicate_report?.resources || 1} item${p.duplicate_report?.resources === 1 ? "" : "s"}.`,
                        );
                        go(p.id);
                      })
                    }
                  >
                    Duplicate {node.kind}
                  </button>
                )}
                {editable && !["record", "workspace"].includes(node.kind) && (
                  <button
                    onClick={() => {
                      setPanel("move");
                      setMenu(false);
                    }}
                  >
                    Move page
                  </button>
                )}
                {editable && node.kind !== "workspace" && (
                  <button
                    className="danger"
                    onClick={() => {
                      setPanel("trash");
                      setMenu(false);
                    }}
                  >
                    Move to trash
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="document-header">
        <input
          className="document-icon"
          aria-label="Page icon"
          defaultValue={node.icon || icon(node)}
          maxLength={20}
          readOnly={!editable}
          onBlur={(e) => {
            if (editable && e.target.value !== node.icon)
              run(async () => {
                await api(`/resources/${id}`, "PATCH", {
                  icon: e.target.value,
                });
                changed();
              });
          }}
        />
        <input
          key={node.title}
          className="document-title"
          aria-label="Page title"
          defaultValue={node.title}
          readOnly={!editable || node.kind === "record"}
          onBlur={(e) => {
            if (
              editable &&
              e.target.value.trim() &&
              e.target.value !== node.title
            )
              run(async () => {
                await api(`/resources/${id}`, "PATCH", {
                  title: e.target.value,
                });
                changed();
              });
          }}
        />
        <div className="document-meta">
          <span>
            {node.kind === "database"
              ? "A shared view of the work that matters."
              : collection
                ? "A little structure for everything your team is building."
                : `Updated ${date(node.updated_at)}`}
          </span>
          <span className="permission-pill">
            {
              ["", "Can view", "Can comment", "Can edit", "Can manage"][
                node.effective_permission
              ]
            }
          </span>
        </div>
      </div>
      {node.kind !== "database" && (
        <FeatureExample
          feature={collection ? "space" : node.kind === "record" ? "record" : "page"}
        />
      )}
      {collection ? (
        <>
          <div className="section-title">
            <h2>
              {node.kind === "workspace" ? "Spaces" : "Pages & databases"}
            </h2>
            {editable && (
              <button
                className="button"
                onClick={() =>
                  create({
                    parent: id,
                    kind: node.kind === "workspace" ? "space" : "page",
                  })
                }
              >
                <Plus size={16} />
                Add {node.kind === "workspace" ? "space" : "page"}
              </button>
            )}
          </div>
          {children.length ? (
            <div className="page-list">
              {children.map((n) => (
                <button
                  key={n.id}
                  className="collection-row"
                  onClick={() => go(n.id)}
                >
                  <span className="page-icon">{icon(n)}</span>
                  <div>
                    <strong>{n.title}</strong>
                    <small>
                      {n.kind} · Updated {date(n.updated_at)}
                    </small>
                  </div>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="There’s room for your next idea.">
              <p>Create the first page in this space.</p>
            </Empty>
          )}
        </>
      ) : node.kind === "database" ? (
        <Database key={id} id={id} editable={editable} />
      ) : (
        <>
          {record && (
            <div className="record-properties">
              {record.properties.map((p: any) => (
                <div key={p.id}>
                  <label>{p.name}</label>
                  <PropertyInput
                    p={p}
                    value={record.values[p.id]}
                    members={members}
                    databaseId={record.database_id}
                    disabled={!editable}
                    save={(value) =>
                      run(async () => {
                        await api(`/records/${id}`, "PATCH", {
                          values: { [p.id]: value },
                          expected_revision: record.revision,
                        });
                        await load();
                        changed();
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <Editor id={id} user={me.user} theme={theme}
            commentable={node.effective_permission >= 2}
            onCommentBlock={(blockId: string) => {
              setCommentAnchor(blockId);
              setPanel("comments");
            }} />
          <Backlinks id={id} />
        </>
      )}
      {panel === "permissions" && (
        <Permissions
          id={id}
          editable={node.effective_permission === 4}
          close={() => setPanel("")}
        />
      )}{" "}
      {panel === "comments" && (
        <Comments
          id={id}
          me={me}
          level={node.effective_permission}
          anchorable={["page", "record"].includes(node.kind)}
          initialAnchor={commentAnchor}
          close={() => setPanel("")}
        />
      )}{" "}
      {panel === "history" && (
        <HistoryPanel id={id} editable={editable} close={() => setPanel("")} />
      )}{" "}
      {panel === "files" && (
        <Files id={id} editable={editable} close={() => setPanel("")} />
      )}{" "}
      {panel === "activity" && (
        <ActivityPanel id={id} close={() => setPanel("")} />
      )}{" "}
      {panel === "move" && (
        <Move
          id={id}
          current={node.parent_id}
          kind={node.kind}
          close={() => setPanel("")}
        />
      )}{" "}
      {panel === "trash" && (
        <Modal title="Move this page to trash?" close={() => setPanel("")}>
          <p className="modal-copy">
            “{node.title}” and its nested pages will move to trash. You can
            restore them later.
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setPanel("")}>
              Cancel
            </button>
            <button
              className="button danger-button"
              onClick={() =>
                run(async () => {
                  await api(`/resources/${id}`, "DELETE");
                  changed();
                  onGone();
                })
              }
            >
              Move to trash
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}
function Backlinks({ id }: { id: string }) {
  const [links,setLinks]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState(false);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const request=useRef(0);
  const refresh=useCallback(async()=>{
    const generation=++request.current;
    // Recheck authority on every focus/manual refresh. Previous titles must
    // never remain visible while a new ACL decision is in flight.
    setLinks([]);
    setNextCursor(null);
    setHasMore(false);
    setLoadingMore(false);
    setError(false);
    setLoading(true);
    try {
      const current=await api(`/resources/${id}/backlinks?limit=20`);
      if(generation===request.current){
        setLinks(current.items);
        setNextCursor(current.next_cursor);
        setHasMore(current.has_more);
        setError(false);
      }
    } catch {
      if(generation===request.current){
        setLinks([]);
        setNextCursor(null);
        setHasMore(false);
        setError(true);
      }
    } finally {
      if(generation===request.current)setLoading(false);
    }
  },[id]);
  const loadMore=useCallback(async()=>{
    if(!nextCursor||loadingMore)return;
    const generation=request.current;
    setLoadingMore(true);
    try {
      const current=await api(
        `/resources/${id}/backlinks?limit=20&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if(generation===request.current){
        setLinks(previous=>{
          const seen=new Set(previous.map(link=>link.id));
          return [...previous,...current.items.filter((link:any)=>!seen.has(link.id))];
        });
        setNextCursor(current.next_cursor);
        setHasMore(current.has_more);
        setError(false);
      }
    } catch {
      if(generation===request.current){
        // A continuation error may be an access change; never preserve stale
        // private titles after a failed authorization-sensitive request.
        setLinks([]);
        setNextCursor(null);
        setHasMore(false);
        setError(true);
      }
    } finally {
      if(generation===request.current)setLoadingMore(false);
    }
  },[id,nextCursor,loadingMore]);
  useEffect(()=>{
    void refresh();
    const onFocus=()=>void refresh();
    window.addEventListener("focus",onFocus);
    return ()=>{
      request.current++;
      window.removeEventListener("focus",onFocus);
    };
  },[refresh]);
  return (
    <section className="backlinks" aria-label="Linked from">
      <div className="section-title">
        <h2>Linked from</h2>
        <button type="button" className="text-button" onClick={() => void refresh()}>
          Refresh links
        </button>
      </div>
      <FeatureExample feature="backlinks" compact />
      {loading ? (
        <p className="muted">Checking accessible page links…</p>
      ) : error ? (
        <p role="alert">Unable to load backlinks. Try refreshing.</p>
      ) : links.length ? (
        <>
          <div className="backlink-items">
            {links.map((source: any) => (
              <button type="button" key={source.id} onClick={() => go(source.id)}>
                <span>{source.title}</span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          </div>
          {hasMore&&nextCursor&&(
            <button type="button" className="text-button"
              onClick={()=>void loadMore()} disabled={loadingMore}>
              {loadingMore?"Loading more…":"Load more links"}
            </button>
          )}
        </>
      ) : hasMore&&nextCursor ? (
        <button type="button" className="text-button"
          onClick={()=>void loadMore()} disabled={loadingMore}>
          {loadingMore?"Checking more links…":"Check more links"}
        </button>
      ) : <p className="muted">No accessible pages link here yet.</p>}
    </section>
  );
}

export function Permissions({
  id,
  editable,
  close,
}: {
  id: string;
  editable: boolean;
  close: () => void;
}) {
  const [data, setData] = useState<any>(),
    [members, setMembers] = useState<any[]>([]),
    [inherit, setInherit] = useState(true),
    [grants, setGrants] = useState<any[]>([]);
  useEffect(() => {
    run(async () => {
      const d = await api(`/resources/${id}/permissions`);
      setData(d);
      setMembers(await api("/members"));
      const local = d.policy.at(-1);
      setInherit(local.inherit);
      setGrants(local.grants);
    });
  }, [id]);
  return (
    <Modal title="Manage access" close={close}>
      <FeatureExample feature="permissions" compact />
      <div className="form">
        <p className="muted">
          Access follows the parent page. An ancestor with no access blocks its
          descendants. Owners and admins can manage all pages.
        </p>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={inherit}
            disabled={!editable}
            onChange={(e) => setInherit(e.target.checked)}
          />
          Inherit access from parent
        </label>
        <div className="grants">
          {grants.map((g, i) => (
            <div key={g.principal_id}>
              <select
                disabled={!editable}
                aria-label="Principal"
                value={g.principal_id}
                onChange={(e) =>
                  setGrants((v) =>
                    v.map((x, j) =>
                      j === i ? { ...x, principal_id: e.target.value } : x,
                    ),
                  )
                }
              >
                <option value="*">Everyone in organisation</option>
                {members.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                    {m.is_service ? " (integration)" : ""}
                  </option>
                ))}
              </select>
              <select
                disabled={!editable}
                aria-label="Access level"
                value={g.level}
                onChange={(e) =>
                  setGrants((v) =>
                    v.map((x, j) =>
                      i === j ? { ...x, level: Number(e.target.value) } : x,
                    ),
                  )
                }
              >
                {["No access", "View", "Comment", "Edit", "Manage"].map(
                  (s, i) => (
                    <option key={i} value={i}>
                      {s}
                    </option>
                  ),
                )}
              </select>
              {editable && (
                <button
                  className="icon-button"
                  aria-label="Remove grant"
                  onClick={() => setGrants((v) => v.filter((_, j) => i !== j))}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        {editable && (
          <button
            className="button"
            onClick={() =>
              setGrants((v) => [
                ...v,
                {
                  principal_id:
                    members.find((m) => !v.some((g) => g.principal_id === m.id))
                      ?.id || "*",
                  level: 1,
                },
              ])
            }
          >
            Add person or integration
          </button>
        )}
        <p className="muted small-text">
          Your access: {data?.effective_permission}. For guest and integration
          principals, grant access at the workspace root before granting a
          nested page.
        </p>
        {editable && (
          <div className="modal-actions">
            <button
              className="button primary"
              onClick={() =>
                run(async () => {
                  await api(`/resources/${id}/permissions`, "PATCH", {
                    inherit,
                    grants,
                    expected_revision: data.revision,
                  });
                  notify("Access updated");
                  changed();
                  close();
                })
              }
            >
              Save access
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
function Comments({
  id,
  me,
  level,
  anchorable,
  initialAnchor,
  close,
}: {
  id: string;
  me: any;
  level: number;
  anchorable: boolean;
  initialAnchor: string;
  close: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [body, setBody] = useState(""),
    [members, setMembers] = useState<any[]>([]),
    [editing, setEditing] = useState(""),
    [replyTo, setReplyTo] = useState(""),
    [anchor, setAnchor] = useState(initialAnchor),
    [blocks, setBlocks] = useState<Map<string,string>>(new Map());
  function indexBlocks(items: any[], result = new Map<string,string>()) {
    for (const block of items) {
      if (typeof block.id === "string")
        result.set(block.id, typeof block.type === "string" ? block.type : "block");
      if (Array.isArray(block.children)) indexBlocks(block.children,result);
    }
    return result;
  }
  const load = async () => {
    const discussions=await api(`/resources/${id}/comments`);
    setRows(discussions);
    if (anchorable) {
      const content=await api(`/pages/${id}/content`);
      setBlocks(indexBlocks(content.blocks));
    }
  };
  useEffect(() => {
    run(load);
    api("/members")
      .then(setMembers)
      .catch(() => {});
  }, [id]);
  const threaded = rows
    .filter((comment) => !comment.parent_comment_id)
    .flatMap((root) => [
      root,
      ...rows.filter((comment) => comment.parent_comment_id === root.id)
        .reverse(),
    ]);
  const replyingTo = rows.find((comment) => comment.id === replyTo);
  return (
    <Modal title="Discussion" close={close}>
      <FeatureExample feature="comments" compact />
      <div className="comments" aria-label="Discussion threads">
        {threaded.length ? (
          threaded.map((c) => (
            <div
              key={c.id}
              className={`comment ${c.parent_comment_id ? "comment-reply" : ""} ${c.resolved ? "resolved" : ""}`}
              data-comment-id={c.id}
              data-parent-comment-id={c.parent_comment_id || undefined}
            >
              <span className="avatar small">{c.author[0]}</span>
              <div>
                <strong>{c.author}</strong>
                {c.parent_comment_id && (
                  <small aria-label="Thread reply">Reply in thread</small>
                )}
                {c.block_id ? (
                  <div className="muted">
                    {blocks.has(c.block_id) ? (
                      <>
                        <span>On {blocks.get(c.block_id)} · </span>
                        <button type="button" className="button small-button"
                          aria-label="Go to commented block"
                          onClick={() => {
                            const target = Array.from(
                              document.querySelectorAll<HTMLElement>(".bn-block[data-id]"),
                            ).find((element) => element.dataset.id === c.block_id);
                            close();
                            target?.scrollIntoView({block:"center",behavior:"smooth"});
                            target?.focus();
                          }}>
                          Jump to block
                        </button>
                      </>
                    ) : <span>Original block removed · comment retained</span>}
                  </div>
                ) : <small>Page discussion</small>}
                <small>
                  {date(c.created_at)}
                  {c.resolved ? " · Resolved" : ""}
                </small>
                <p>
                  {c.body.replace(
                    /@\{([a-f0-9-]+)\}/g,
                    (_: string, id: string) =>
                      "@" +
                      (members.find((m) => m.id === id)?.name || "member"),
                  )}
                </p>
                <div className="comment-actions">
                  {level >= 2 && !c.parent_comment_id && !c.resolved && (
                    <button type="button"
                      aria-label={`Reply to ${c.author}`}
                      onClick={() => {
                        setReplyTo(c.id);
                        setEditing("");
                        setBody("");
                      }}>
                      Reply
                    </button>
                  )}
                  {(c.author_id === me.user.id || level >= 3) && !c.parent_comment_id && (
                    <button
                      onClick={() =>
                        run(async () => {
                          await api(
                            `/resources/${id}/comments/${c.id}`,
                            "PATCH",
                            { resolved: !c.resolved },
                          );
                          await load();
                        })
                      }
                    >
                      {c.resolved ? "Reopen" : "Resolve"}
                    </button>
                  )}
                  {(c.author_id === me.user.id ||
                    ["owner", "admin"].includes(me.user.role)) && (
                    <>
                      <button
                        onClick={() => {
                          setEditing(c.id);
                          setReplyTo("");
                          setBody(c.body);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() =>
                          run(async () => {
                            await api(
                              `/resources/${id}/comments/${c.id}`,
                              "DELETE",
                            );
                            await load();
                          })
                        }
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <Empty title="Start the conversation." />
        )}
      </div>
      {level >= 2 && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              // A failed POST never clears the draft. Re-fetch the current
              // canonical version; the server atomically checks its block ID
              // and revision against the page row before creating a comment.
              let payload: {
                body:string;block_id?:string;expected_revision?:number;reply_to?:string;
              }={body};
              if (!editing && replyTo) {
                // Never silently convert an inaccessible/resolved reply into a
                // new root. Server verifies tenant, page and active permission.
                payload={body,reply_to:replyTo};
              } else if (!editing && anchor && anchorable) {
                const content=await api(`/pages/${id}/content`);
                const current=indexBlocks(content.blocks);
                setBlocks(current);
                if (!current.has(anchor)) {
                  notify("The selected block was removed. Your draft is saved; choose a page comment.");
                  return;
                }
                payload={body,block_id:anchor,expected_revision:content.revision};
              }
              await api(
                `/resources/${id}/comments${editing ? `/${editing}` : ""}`,
                editing ? "PATCH" : "POST",
                payload,
              );
              setBody("");
              setEditing("");
              setReplyTo("");
              await load();
            });
          }}
        >
          {replyingTo && !editing && (
            <div className="form-row" role="status">
              <p className="muted">Replying to {replyingTo.author} in this thread</p>
              <button type="button" className="button small-button"
                onClick={() => setReplyTo("")}>Cancel reply</button>
            </div>
          )}
          {!editing && !replyTo && anchorable && (
            <div className="form-row">
              {anchor ? (
                <p role="status" className="muted">
                  {blocks.has(anchor)
                    ? `Commenting on selected ${blocks.get(anchor)}`
                    : "Selected block removed — switch to page discussion"}
                </p>
              ) : (
                <p className="muted">Commenting on the whole page</p>
              )}
              {anchor && (
                <button type="button" className="button small-button"
                  onClick={() => setAnchor("")}>
                  Switch to page comment
                </button>
              )}
            </div>
          )}
          <textarea
            aria-label={editing ? "Edit comment text" : replyTo ? "Reply text" : "New comment text"}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={replyTo ? "Write a reply…" : "Add a thoughtful comment…"}
            required
            maxLength={10000}
          />
          <div className="split">
            <select
              aria-label="Mention a person"
              value=""
              onChange={(e) => setBody((v) => v + ` @{${e.target.value}} `)}
            >
              <option value="">@ Mention a person</option>
              {members
                .filter((m) => !m.is_service && m.active)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <button className="button primary">
              {editing ? "Save edit" : replyTo ? "Post reply" : "Post comment"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function HistoryPanel({
  id,
  editable,
  close,
}: {
  id: string;
  editable: boolean;
  close: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [preview, setPreview] = useState<any>();
  useEffect(() => {
    run(async () => setRows(await api(`/pages/${id}/versions`)));
  }, [id]);
  return (
    <Modal title="Version history" close={close}>
      <FeatureExample feature="history" compact />
      <p className="modal-copy muted">
        Checkpoints are kept before replacements and at most once per five
        minutes of live editing. Restoring creates a new revision.
      </p>
      {rows.map((v) => (
        <div className="history-row" key={v.id}>
          <button
            onClick={() =>
              run(async () =>
                setPreview(await api(`/pages/${id}/versions/${v.id}`)),
              )
            }
          >
            <strong>Revision {v.revision}</strong>
            <small>
              {date(v.created_at)} · {v.author} · {v.context}
            </small>
          </button>
          {editable && (
            <button
              className="button"
              onClick={() =>
                run(async () => {
                  const d = await api(`/pages/${id}/content`);
                  await api(`/pages/${id}/versions/${v.id}/restore`, "POST", {
                    expected_revision: d.revision,
                  });
                  notify("Version restored as a new revision");
                  close();
                })
              }
            >
              Restore
            </button>
          )}
        </div>
      ))}
      {!rows.length && <Empty title="History will appear as you edit." />}
      {preview && (
        <pre className="version-preview">
          {JSON.stringify(preview.blocks, null, 2)}
        </pre>
      )}
    </Modal>
  );
}
function Files({
  id,
  editable,
  close,
}: {
  id: string;
  editable: boolean;
  close: () => void;
}) {
  const [files, setFiles] = useState<any[]>([]);
  const load = async () => setFiles(await api(`/resources/${id}/files`));
  useEffect(() => {
    run(load);
  }, [id]);
  return (
    <Modal title="Private attachments" close={close}>
      <FeatureExample feature="files" compact />
      <div className="form">
        {files.map((f) => (
          <div className="file-row" key={f.id}>
            <a
              href={`/api/v1/files/${f.id}/content`}
              target="_blank"
              rel="noreferrer"
            >
              <Paperclip size={15} />
              {f.name}
            </a>
            <small>{Math.ceil(Number(f.size) / 1024)} KB</small>
            {editable && (
              <button
                className="text-button"
                onClick={() =>
                  run(async () => {
                    await api(`/files/${f.id}`, "DELETE");
                    await load();
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {!files.length && (
          <Empty title="Keep useful files with their context." />
        )}
        {editable && (
          <Field label="Upload an attachment (up to 25 MB)">
            <input
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  run(async () => {
                    const form = new FormData();
                    form.append("file", f);
                    await api(`/resources/${id}/files`, "POST", form);
                    await load();
                  });
              }}
            />
          </Field>
        )}
        <p className="muted small-text">
          Downloads always use the page’s current access rules.
        </p>
      </div>
    </Modal>
  );
}
function ActivityPanel({ id, close }: { id: string; close: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    run(async () => setRows(await api(`/resources/${id}/activity`)));
  }, [id]);
  return (
    <Modal title="Page activity" close={close}>
      <FeatureExample feature="activity" compact />
      <div className="activity-list">
        {rows.map((n) => (
          <div key={n.id}>
            <span className="activity-dot" />
            <div>
              <strong>{n.actor || "Workspace"}</strong>
              <span>{n.action.replaceAll(".", " ")}</span>
            </div>
            <small>{date(n.created_at)}</small>
          </div>
        ))}
      </div>
    </Modal>
  );
}
function Move({
  id,
  current,
  kind,
  close,
}: {
  id: string;
  current: string;
  kind: string;
  close: () => void;
}) {
  const [q, setQ] = useState(""),
    [rows, setRows] = useState<any[]>([]),
    [parent, setParent] = useState(current),
    [position, setPosition] = useState("");
  useEffect(() => {
    run(async () =>
      setRows(
        kind === "space"
          ? await api("/resources")
          : q
            ? await api(`/search?q=${encodeURIComponent(q)}`)
            : await api(`/resources?parent_id=${current}`),
      ),
    );
  }, [q]);
  return (
    <Modal title="Move or reorder" close={close}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api(`/resources/${id}`, "PATCH", {
              parent_id: parent,
              ...(position ? { position: Number(position) } : {}),
            });
            changed();
            close();
          });
        }}
      >
        <Field label="Find a destination">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages or spaces"
          />
        </Field>
        <Field label="Destination">
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value={current}>Current parent</option>
            {rows
              .filter(
                (n) =>
                  n.id !== id &&
                  (kind === "space"
                    ? n.kind === "workspace"
                    : ["space", "page"].includes(n.kind)),
              )
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Position (optional)">
          <input
            type="number"
            step="any"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="Lower numbers appear first"
          />
        </Field>
        <button className="button primary">Save location</button>
      </form>
    </Modal>
  );
}
