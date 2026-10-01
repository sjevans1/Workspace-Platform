"use client";
import { useEffect, useState } from "react";
import { Plus, Copy, ArrowUpRight } from "lucide-react";
import { api, run, notify, changed, date } from "../lib/api";
import { Modal, Field } from "./common";
export default function Settings({
  me,
  reload,
}: {
  me: any;
  reload: () => Promise<void>;
}) {
  const [tab, setTab] = useState("profile"),
    [members, setMembers] = useState<any[]>([]),
    [branding, setBranding] = useState(me.branding),
    [integrations, setIntegrations] = useState<any[]>([]),
    [scimConnectors, setScimConnectors] = useState<any[]>([]),
    [scimGroups, setScimGroups] = useState<any[]>([]),
    [hooks, setHooks] = useState<any>({ subscriptions: [], deliveries: [] }),
    [audit, setAudit] = useState<any[]>([]),
    [modal, setModal] = useState(""),
    [secret, setSecret] = useState("");
  const admin = ["owner", "admin"].includes(me.user.role);
  const tabs = admin
    ? ["profile", "members", "branding", "integrations", "webhooks", "audit"]
    : ["profile"];
  async function load() {
    if (!admin) return;
    setMembers(await api("/members"));
    setIntegrations(await api("/integrations"));
    setScimConnectors(await api("/scim/connectors"));
    setScimGroups(await api("/scim/groups"));
    setHooks(await api("/webhooks"));
    setAudit(await api("/audit"));
  }
  useEffect(() => {
    run(load);
  }, []);
  function submit(
    fn: (v: Record<string, FormDataEntryValue>) => Promise<void>,
  ) {
    return (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.currentTarget));
      run(() => fn(v));
    };
  }
  return (
    <div className="settings-page">
      <div className="eyebrow">MAKE IT YOURS</div>
      <h1>Settings & members</h1>
      <p className="lead">Your team, your workspace, your way of working.</p>
      <div className="settings-tabs">
        {tabs.map((t) => (
          <button
            className={tab === t ? "active" : ""}
            key={t}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "profile" && (
        <>
          <section className="settings-section">
            <h2>Your account</h2>
            <p>
              {me.user.name} · {me.user.email} ·{" "}
              <span className="tag">{me.user.role}</span>
            </p>
            {me.authentication?.local !== false ? (
              <form
                className="form narrow"
                onSubmit={submit(async (v) => {
                  await api("/auth/password", "POST", {
                    current: v.current,
                    password: v.password,
                  });
                  notify(
                    "Password changed. Other sessions have been signed out.",
                  );
                })}
              >
                <Field label="Current password">
                  <input
                    name="current"
                    type="password"
                    required
                    autoComplete="current-password"
                  />
                </Field>
                <Field label="New password (at least 12 characters)">
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                  />
                </Field>
                <button className="button">Update password</button>
              </form>
            ) : (
              <p className="muted">
                Local password sign-in is disabled for this deployment. Use
                your configured single sign-on provider.
              </p>
            )}
          </section>
          <section className="settings-section">
            <h2>Organisation</h2>
            <select
              aria-label="Current organisation"
              value={me.organisation.id}
              onChange={(e) =>
                run(async () => {
                  await api("/auth/switch", "POST", {
                    tenant_id: e.target.value,
                  });
                  location.href = "/";
                })
              }
            >
              {me.organisations.map((o: any) => (
                <option key={o.tenant_id} value={o.tenant_id}>
                  {o.name}
                </option>
              ))}
            </select>
            {admin && (
              <div className="button-row">
                <button
                  className="button"
                  onClick={() => setModal("workspace")}
                >
                  <Plus size={15} />
                  New workspace
                </button>
                {me.capabilities?.self_service_organisation_creation && (
                  <button
                    className="button"
                    onClick={() => setModal("organisation")}
                  >
                    <Plus size={15} />
                    New organisation
                  </button>
                )}
              </div>
            )}
          </section>
        </>
      )}
      {tab === "members" && (
        <section className="settings-section">
          <div className="section-title">
            <h2>People in {me.organisation.name}</h2>
            <button
              className="button primary"
              onClick={() => setModal("invite")}
            >
              <Plus size={15} />
              Invite a teammate
            </button>
          </div>
          <div className="member-list">
            {members
              .filter((m) => !m.is_service)
              .map((m) => (
                <div className="member-row" key={m.id}>
                  <span className="avatar">{m.name[0]}</span>
                  <div className="member-name">
                    <strong>{m.name}</strong>
                    <small>{m.email}</small>
                  </div>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(e) =>
                      run(async () => {
                        await api(`/members/${m.id}`, "PATCH", {
                          role: e.target.value,
                        });
                        await load();
                      })
                    }
                  >
                    {["owner", "admin", "member", "guest"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <button
                    className="button quiet"
                    onClick={() =>
                      run(async () => {
                        await api(`/members/${m.id}`, "PATCH", {
                          active: !m.active,
                        });
                        await load();
                      })
                    }
                  >
                    {m.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}
      {tab === "branding" && (
        <section className="settings-section">
          <h2>Brand identity</h2>
          <p className="muted">
            These settings apply to your organisation’s signed-in workspace. The
            deployment’s environment sets the sign-in branding.
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api("/branding", "PATCH", branding);
                await reload();
                notify("Branding saved");
              });
            }}
          >
            <div className="form-grid">
              {Object.keys(branding).map((k) => (
                <Field
                  label={k
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (x) => x.toUpperCase())}
                  key={k}
                >
                  <input
                    type={k === "primaryAccent" ? "color" : "text"}
                    value={branding[k]}
                    onChange={(e) =>
                      setBranding({ ...branding, [k]: e.target.value })
                    }
                    required={["productName", "primaryAccent"].includes(k)}
                  />
                </Field>
              ))}
            </div>
            <div
              className="brand-preview"
              style={{ borderColor: branding.primaryAccent }}
            >
              <span style={{ background: branding.primaryAccent }}>✳</span>
              <strong>{branding.productName}</strong>
              <small>{branding.legalName}</small>
            </div>
            <button className="button primary">Save branding</button>
          </form>
        </section>
      )}
      {tab === "integrations" && (
        <section className="settings-section">
          <div className="section-title">
            <h2>Service credentials</h2>
            <button
              className="button primary"
              onClick={() => setModal("integration")}
            >
              <Plus size={15} />
              Create credential
            </button>
          </div>
          <p className="muted">
            Each integration has its own guest principal and starts with no
            content access. Grant it access from the workspace’s “Manage access”
            menu. Credentials default to read scopes.
          </p>
          {integrations.map((t) => (
            <div className="integration-row" key={t.credential_id}>
              <div>
                <strong>{t.label}</strong>
                <small>Expires {date(t.expires_at)}</small>
                <code>{t.user_id}</code>
                <p className="small-text muted">{t.scopes.join(" · ")}</p>
              </div>
              <button
                className="button"
                onClick={() =>
                  run(async () => {
                    await api(`/integrations/${t.credential_id}`, "DELETE");
                    await load();
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
          <a
            className="text-button"
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
          >
            Explore the API <ArrowUpRight size={15} />
          </a>
          <hr className="section-divider" />
          <div className="section-title">
            <div>
              <h2>Directory provisioning (SCIM 2.0)</h2>
              <p className="muted">
                Provision and deactivate member or guest access from an
                enterprise identity directory. Deactivation immediately revokes
                this organisation’s Workspace sessions.
              </p>
            </div>
            <button
              className="button primary"
              onClick={() => setModal("scim")}
            >
              <Plus size={15} />
              Create SCIM connector
            </button>
          </div>
          {scimConnectors.length === 0 && (
            <p className="muted">No SCIM connectors configured.</p>
          )}
          {scimConnectors.map((connector: any) => (
            <div className="integration-row" key={connector.id}>
              <div>
                <strong>{connector.label}</strong>
                <small>
                  Default role: {connector.default_role} · Last used{" "}
                  {connector.last_used_at ? date(connector.last_used_at) : "never"}
                </small>
                <p className="small-text muted">
                  {connector.revoked_at
                    ? `Revoked ${date(connector.revoked_at)}`
                    : "Active"}
                </p>
              </div>
              {!connector.revoked_at && (
                <button
                  className="button"
                  onClick={() =>
                    run(async () => {
                      await api(`/scim/connectors/${connector.id}`, "DELETE");
                      await load();
                    })
                  }
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
          <h3>Directory group role mapping</h3>
          <p className="muted">
            Groups arrive from the directory through SCIM. Map only the groups
            that should influence Workspace roles. Directory groups can map to
            guest or member, never admin or owner.
          </p>
          {scimGroups.length === 0 && (
            <p className="muted">
              No SCIM groups have been synchronized yet.
            </p>
          )}
          {scimGroups.map((group: any) => (
            <div className="integration-row" key={group.id}>
              <div>
                <strong>{group.display_name}</strong>
                <small>
                  {group.member_count} member
                  {group.member_count === 1 ? "" : "s"}
                  {group.external_id ? ` · ${group.external_id}` : ""}
                </small>
              </div>
              <Field label={`Role mapping for ${group.display_name}`}>
                <select
                  aria-label={`Role mapping for ${group.display_name}`}
                  value={group.mapped_role || ""}
                  onChange={(event) =>
                    run(async () => {
                      await api(`/scim/groups/${group.id}/role`, "PATCH", {
                        role: event.target.value || null,
                      });
                      await load();
                    })
                  }
                >
                  <option value="">No role mapping</option>
                  <option value="guest">guest</option>
                  <option value="member">member</option>
                </select>
              </Field>
            </div>
          ))}
        </section>
      )}
      {tab === "webhooks" && (
        <section className="settings-section">
          <div className="section-title">
            <h2>Event subscriptions</h2>
            <button
              className="button primary"
              onClick={() => setModal("webhook")}
            >
              <Plus size={15} />
              Add webhook
            </button>
          </div>
          <p className="muted">
            Receive signed event references at deployment-approved destinations.
            Check signatures and fetch current content through a permissioned
            service credential.
          </p>
          {hooks.subscriptions.map((h: any) => (
            <div className="integration-row" key={h.id}>
              <div>
                <strong>{h.url}</strong>
                <small>{h.events.join(", ")}</small>
              </div>
              <button
                className="button"
                onClick={() =>
                  run(async () => {
                    await api(`/webhooks/${h.id}`, "PATCH", {
                      active: !h.active,
                    });
                    await load();
                  })
                }
              >
                {h.active ? "Pause" : "Enable"}
              </button>
            </div>
          ))}
          <h3>Recent deliveries</h3>
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Last result</th>
                </tr>
              </thead>
              <tbody>
                {hooks.deliveries.map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.event_id.slice(0, 8)}</code>
                    </td>
                    <td>
                      <span className="tag">{d.status}</span>
                    </td>
                    <td>{d.attempts}</td>
                    <td>{d.last_error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="button" onClick={() => run(load)}>
            Refresh deliveries
          </button>
        </section>
      )}
      {tab === "audit" && (
        <section className="settings-section">
          <h2>Audit trail</h2>
          <div className="table-scroll">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.created_at).toLocaleString()}</td>
                    <td>{a.actor || "System"}</td>
                    <td>{a.action}</td>
                    <td>
                      <code>{a.resource_id?.slice(0, 8) || "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {modal && (
        <Modal
          title={
            modal === "invite"
              ? "Invite a teammate"
              : modal === "integration"
                ? "Create service credential"
                : modal === "scim"
                  ? "Create SCIM connector"
                  : modal === "webhook"
                  ? "Add event subscription"
                  : `New ${modal}`
          }
          close={() => setModal("")}
        >
          <form
            className="form"
            onSubmit={submit(async (v) => {
              if (modal === "invite") {
                const r = await api("/members/invite", "POST", {
                  name: v.name,
                  email: v.email,
                  role: v.role,
                });
                setSecret(r.url);
              } else if (modal === "integration") {
                const scopes = [
                  "workspace.read",
                  "pages.read",
                  "databases.read",
                  "files.read",
                  "permissions.read",
                  "events.read",
                ];
                if (v.write === "on")
                  scopes.push(
                    "workspace.write",
                    "pages.write",
                    "databases.write",
                    "files.write",
                  );
                const r = await api("/integrations", "POST", {
                  name: v.name,
                  scopes,
                });
                setSecret(
                  `Token: ${r.token}\nPrincipal: ${r.principal_id}\nSave this token now. It will not be shown again.`,
                );
              } else if (modal === "scim") {
                const r = await api("/scim/connectors", "POST", {
                  label: v.name,
                  default_role: v.default_role,
                });
                setSecret(
                  `SCIM base URL: ${r.base_url}\nBearer token: ${r.token}\nDefault role: ${r.default_role}\n\nSave this token now. It will not be shown again.`,
                );
              } else if (modal === "webhook") {
                const r = await api("/webhooks", "POST", {
                  url: v.url,
                  events: String(v.events)
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                });
                setSecret(
                  `Signing secret: ${r.secret}\nSave this secret now. It will not be shown again.`,
                );
              } else if (modal === "workspace") {
                await api("/resources", "POST", {
                  kind: "workspace",
                  title: v.name,
                });
                changed();
                await reload();
              } else {
                await api("/organisations", "POST", { name: v.name });
                await reload();
              }
              setModal("");
              await load();
            })}
          >
            {modal !== "webhook" && (
              <Field label="Name">
                <input name="name" required autoFocus />
              </Field>
            )}
            {modal === "invite" && (
              <>
                <Field label="Email">
                  <input name="email" type="email" required />
                </Field>
                <Field label="Role">
                  <select name="role">
                    <option>member</option>
                    <option>guest</option>
                    <option>admin</option>
                  </select>
                </Field>
                <p className="muted small-text">
                  Creates a single-use link valid for seven days. Copy and share
                  it with your teammate.
                </p>
              </>
            )}
            {modal === "integration" && (
              <label className="checkbox-line">
                <input type="checkbox" name="write" />
                Allow write API scopes
              </label>
            )}
            {modal === "scim" && (
              <>
                <Field label="Default provisioned role">
                  <select name="default_role" defaultValue="member">
                    <option value="member">member</option>
                    <option value="guest">guest</option>
                  </select>
                </Field>
                <p className="muted small-text">
                  SCIM cannot provision owner or administrator roles. Existing
                  manual memberships are never silently adopted into SCIM.
                </p>
              </>
            )}
            {modal === "webhook" && (
              <>
                <Field label="Endpoint URL">
                  <input
                    name="url"
                    type="url"
                    required
                    placeholder="https://events.example.com/workspace"
                  />
                </Field>
                <Field label="Events (comma-separated)">
                  <input
                    name="events"
                    required
                    defaultValue="page.updated,record.updated,permission.updated"
                  />
                </Field>
              </>
            )}
            <button className="button primary">
              Create {modal === "invite" ? "invitation" : modal}
            </button>
          </form>
        </Modal>
      )}
      {secret && (
        <Modal title="Keep this somewhere safe" close={() => setSecret("")}>
          <div className="form">
            <textarea
              aria-label="Created credential or invitation"
              readOnly
              value={secret}
              rows={5}
            />
            <button
              className="button"
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(secret);
                  notify("Copied");
                })
              }
            >
              <Copy size={15} />
              Copy
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
