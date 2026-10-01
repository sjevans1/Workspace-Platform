"use client";
import { useEffect, useState } from "react";
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
import { api, run, notify, changed, go, icon, date } from "../lib/api";
import { Modal, Spinner, Empty, Field } from "./common";
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
    [menu, setMenu] = useState(false),
    [record, setRecord] = useState<any>(),
    [members, setMembers] = useState<any[]>([]);
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
            onClick={() => setPanel("comments")}
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
                {editable && node.kind === "page" && (
                  <button
                    onClick={() =>
                      run(async () => {
                        const p = await api(
                          `/resources/${id}/duplicate`,
                          "POST",
                          {},
                        );
                        changed();
                        go(p.id);
                      })
                    }
                  >
                    Duplicate page
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
        <Database id={id} editable={editable} />
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
          <Editor id={id} user={me.user} theme={theme} />
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
  const [links, setLinks] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false);
  async function refresh() {
    setLoading(true);
    try {
      const rows = await api(`/resources/${id}/backlinks`);
      setLinks(rows);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    api(`/resources/${id}/backlinks`)
      .then((rows) => { if (live) { setLinks(rows); setError(false); } })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id]);
  return (
    <section className="backlinks" aria-label="Linked from">
      <div className="section-title">
        <h2>Linked from</h2>
        <button type="button" className="text-button" onClick={() => void refresh()}>
          Refresh links
        </button>
      </div>
      {loading ? (
        <p className="muted">Checking accessible page links…</p>
      ) : error ? (
        <p role="alert">Unable to load backlinks. Try refreshing.</p>
      ) : links.length ? (
        <div className="backlink-items">
          {links.map((source: any) => (
            <button type="button" key={source.id} onClick={() => go(source.id)}>
              <span>{source.title}</span>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </div>
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
  close,
}: {
  id: string;
  me: any;
  level: number;
  close: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [body, setBody] = useState(""),
    [members, setMembers] = useState<any[]>([]),
    [editing, setEditing] = useState("");
  const load = async () => setRows(await api(`/resources/${id}/comments`));
  useEffect(() => {
    run(load);
    api("/members")
      .then(setMembers)
      .catch(() => {});
  }, [id]);
  return (
    <Modal title="Discussion" close={close}>
      <div className="comments">
        {rows.length ? (
          rows.map((c) => (
            <div
              key={c.id}
              className={`comment ${c.resolved ? "resolved" : ""}`}
            >
              <span className="avatar small">{c.author[0]}</span>
              <div>
                <strong>{c.author}</strong>
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
                  {level >= 2 && (
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
              await api(
                `/resources/${id}/comments${editing ? `/${editing}` : ""}`,
                editing ? "PATCH" : "POST",
                { body },
              );
              setBody("");
              setEditing("");
              await load();
            });
          }}
        >
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a thoughtful comment…"
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
              {editing ? "Save edit" : "Post comment"}
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
