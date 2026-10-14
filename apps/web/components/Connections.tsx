"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  Play,
  RotateCw,
  Power,
  PowerOff,
  Trash,
} from "lucide-react";
import { api, run, notify } from "../lib/api";
import { Modal, Field, Empty } from "./common";

type Provider = {
  key: string;
  display_name: string;
  category: string;
  implemented: boolean;
  capabilities: string[];
  ownership: string[];
  credential_kinds: string[];
  webhook: boolean;
  polling: boolean;
  health_check: boolean;
};

type Connection = {
  id: string;
  provider_key: string;
  provider_display_name: string;
  provider_implemented: boolean;
  ownership: string;
  ownership_label: string;
  label: string;
  status: string;
  enabled: boolean;
  capabilities_requested: string[];
  capabilities_granted: string[];
  capabilities_available: string[];
  created_at: string;
  connected_at: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
  last_success_at: string | null;
  last_sync_at: string | null;
  last_event_at: string | null;
  last_error_at: string | null;
  last_error_category: string | null;
  attention_reason: string | null;
};

type ConnectorEvent = {
  id: string;
  event_type: string;
  provider_event_id: string | null;
  verification: string;
  received_at: string;
  duplicate_count: number;
  dispatch_state: string;
};

// The statuses the API reports. Shown as they are, with underscores turned into spaces.
const label = (value: string) => value.replace(/_/g, " ");

export default function Connections({ me }: { me: any }) {
  const admin = ["owner", "admin"].includes(me.user.role);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [declared, setDeclared] = useState<{ key: string }[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [modal, setModal] = useState("");
  const [active, setActive] = useState<Connection | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [note, setNote] = useState<{
    id: string;
    text: string;
    bad: boolean;
  } | null>(null);
  const [events, setEvents] = useState<{
    id: string;
    rows: ConnectorEvent[];
  } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [catalog, list] = await Promise.all([
        api("/connectors/catalog"),
        api("/connectors/connections"),
      ]);
      setProviders(catalog.providers || []);
      setDeclared(catalog.declared || []);
      setConnections(list.connections || []);
      setError("");
    } catch (e) {
      setError((e as Error).message || "Connections could not be loaded.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    run(load);
  }, []);

  function submit(fn: (form: HTMLFormElement) => Promise<void>) {
    return (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      run(() => fn(form));
    };
  }

  const selected = providers.find((p) => p.key === providerKey);
  // A shared (tenant) connection can only be created by an owner or admin, so a
  // member is only ever offered the delegated form and never a control the
  // server would reject.
  const ownershipOptions = selected
    ? selected.ownership.filter((o) => o === "user" || admin)
    : [];

  async function create(form: HTMLFormElement) {
    const data = new FormData(form);
    const key = String(data.get("provider_key") || "");
    const provider = providers.find((p) => p.key === key);
    if (!provider) {
      notify("Choose a provider.");
      return;
    }
    const capabilities = data.getAll("capabilities").map(String);
    const configText = String(data.get("config") || "").trim();
    let config: Record<string, unknown> | undefined;
    if (configText) {
      try {
        config = JSON.parse(configText);
      } catch {
        notify("Configuration must be valid JSON.");
        return;
      }
    }
    const created = await api("/connectors/connections", "POST", {
      provider_key: key,
      label: String(data.get("label") || "").trim(),
      ownership: String(data.get("ownership") || ""),
      ...(capabilities.length ? { capabilities } : {}),
      ...(config ? { config } : {}),
    });
    await load();
    setActive(created.connection);
    setModal("connect");
    notify("Connection created. Supply the credential to finish connecting.");
  }

  async function supplySecret(
    form: HTMLFormElement,
    path: "connect" | "rotate",
  ) {
    if (!active) return;
    const secret = String(new FormData(form).get("secret") || "");
    if (secret.length < 16) {
      notify("The credential must contain at least 16 characters.");
      return;
    }
    await api(`/connectors/connections/${active.id}/${path}`, "POST", {
      secret,
    });
    setModal("");
    setActive(null);
    await load();
    notify(
      path === "connect" ? "Connection established." : "Credential rotated.",
    );
  }

  async function test(connection: Connection) {
    setBusy(connection.id);
    try {
      const r = await api(
        `/connectors/connections/${connection.id}/test`,
        "POST",
        {},
      );
      setNote({
        id: connection.id,
        bad: !r.ok,
        text: r.ok
          ? "Health check succeeded."
          : `Health check failed (${r.category || "unknown"}): ${r.detail || "no detail returned"}.`,
      });
      await load();
    } finally {
      setBusy("");
    }
  }

  async function sync(connection: Connection) {
    setBusy(connection.id);
    try {
      const r = await api(
        `/connectors/connections/${connection.id}/sync`,
        "POST",
        {},
      );
      setNote({
        id: connection.id,
        bad: false,
        // The request queue is what this endpoint touches: it never invokes the
        // provider inline, so the note says so rather than implying work happened.
        text: `Sync queued; the worker performs it. Events processed inline: ${
          r.processed ?? 0
        }. Next attempt ${
          r.next_at ? new Date(r.next_at).toLocaleString() : "not scheduled"
        }.`,
      });
      await load();
    } finally {
      setBusy("");
    }
  }

  async function viewEvents(connection: Connection) {
    if (events && events.id === connection.id) {
      setEvents(null);
      return;
    }
    setBusy(connection.id);
    try {
      const r = await api(`/connectors/connections/${connection.id}/events`);
      setEvents({ id: connection.id, rows: r.events || [] });
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="settings-section">
      <div className="section-title">
        <div>
          <h2>Connections</h2>
          <p className="muted">
            External services connected to this workspace. Workspace works fully
            without any of them.
          </p>
        </div>
        <div className="connections-actions">
          <button
            className="button"
            onClick={() => run(load)}
            disabled={loading}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            className="button primary"
            disabled={!providers.filter((p) => p.implemented).length}
            onClick={() => {
              setProviderKey("");
              setModal("create");
            }}
          >
            <Plus size={15} />
            New connection
          </button>
        </div>
      </div>

      {declared.length > 0 && (
        <p className="muted small-text">
          Declared but not implemented in this release:{" "}
          {declared.map((d) => d.key).join(", ")}. They cannot be connected yet.
        </p>
      )}

      {error && (
        <div role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => run(load)}>
            Try again
          </button>
        </div>
      )}

      {loading && <p className="muted">Loading connections…</p>}

      {!loading && !error && connections.length === 0 && (
        <Empty title="No connections yet.">
          <p>Workspace works fully without any external connection.</p>
        </Empty>
      )}

      {!loading &&
        connections.map((c) => {
          const provider = providers.find((p) => p.key === c.provider_key);
          const perRowNote = note && note.id === c.id ? note : null;
          const perRowEvents =
            events && events.id === c.id ? events.rows : null;
          return (
            <div className="integration-row" key={c.id}>
              <div>
                <strong>{c.label}</strong>
                <small>
                  {c.provider_display_name} · {c.ownership_label} ·{" "}
                  <span className={"tag connections-status-" + c.status}>
                    {label(c.status)}
                  </span>{" "}
                  · {c.enabled ? "enabled" : "disabled"}
                </small>
                <p className="small-text muted">
                  Capabilities granted:{" "}
                  {c.capabilities_granted.length
                    ? c.capabilities_granted.join(", ")
                    : "none"}
                </p>
                <p className="small-text muted">
                  {c.last_sync_at
                    ? `Last sync ${new Date(c.last_sync_at).toLocaleString()}`
                    : "No successful sync yet."}
                </p>
                {c.attention_reason && (
                  <p className="small-text error">
                    Needs attention: {c.attention_reason}
                  </p>
                )}
                {!c.provider_implemented && (
                  <p className="small-text muted">
                    The provider adapter is not implemented, so this connection
                    cannot be tested or synced.
                  </p>
                )}
                {provider?.webhook &&
                  ["connected", "attention_required", "disabled"].includes(
                    c.status,
                  ) && (
                    <p className="small-text muted">
                      Provider callbacks post to{" "}
                      <code>/api/v1/connectors/ingress/{c.id}</code> with the{" "}
                      <code>x-connector-token</code> header, which is the
                      credential you supplied. Events are only accepted while
                      the connection stays enabled.
                    </p>
                  )}
                {perRowNote && (
                  <p
                    className={
                      perRowNote.bad ? "small-text error" : "small-text muted"
                    }
                    role="status"
                  >
                    {perRowNote.text}
                  </p>
                )}
                {perRowEvents && (
                  <div className="table-scroll">
                    <table className="simple-table">
                      <thead>
                        <tr>
                          <th>Received</th>
                          <th>Type</th>
                          <th>Verification</th>
                          <th>Duplicates</th>
                          <th>Dispatch</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perRowEvents.length === 0 && (
                          <tr>
                            <td colSpan={5} className="muted">
                              No events received.
                            </td>
                          </tr>
                        )}
                        {perRowEvents.map((ev) => (
                          <tr key={ev.id}>
                            <td>{new Date(ev.received_at).toLocaleString()}</td>
                            <td>
                              <code>{ev.event_type}</code>
                            </td>
                            <td>{label(ev.verification)}</td>
                            <td>{ev.duplicate_count}</td>
                            <td>{label(ev.dispatch_state)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="connections-actions">
                {c.status === "pending" && (
                  <button
                    className="button primary"
                    disabled={busy === c.id}
                    onClick={() => {
                      setActive(c);
                      setModal("connect");
                    }}
                  >
                    Connect
                  </button>
                )}
                {["connected", "attention_required", "disabled"].includes(
                  c.status,
                ) && (
                  <button
                    className="button"
                    disabled={busy === c.id}
                    onClick={() => {
                      setActive(c);
                      setModal("rotate");
                    }}
                  >
                    <RotateCw size={15} />
                    Rotate credential
                  </button>
                )}
                {c.status !== "revoked" && c.status !== "pending" && (
                  <button
                    className="button"
                    disabled={busy === c.id}
                    onClick={() => run(() => test(c))}
                  >
                    Test
                  </button>
                )}
                {c.provider_implemented &&
                  c.status === "connected" &&
                  c.enabled && (
                    <button
                      className="button"
                      disabled={busy === c.id}
                      onClick={() => run(() => sync(c))}
                    >
                      <Play size={15} />
                      Sync now
                    </button>
                  )}
                {c.status !== "revoked" && c.status !== "pending" && (
                  <button
                    className="button"
                    disabled={busy === c.id}
                    onClick={() =>
                      run(async () => {
                        await api(
                          `/connectors/connections/${c.id}/enabled`,
                          "POST",
                          {
                            enabled: !c.enabled,
                          },
                        );
                        await load();
                      })
                    }
                  >
                    {c.enabled ? <PowerOff size={15} /> : <Power size={15} />}
                    {c.enabled ? "Disable" : "Enable"}
                  </button>
                )}
                {c.status !== "revoked" && (
                  <button
                    className="button"
                    disabled={busy === c.id}
                    onClick={() => run(() => viewEvents(c))}
                  >
                    {perRowEvents ? "Hide events" : "Events"}
                  </button>
                )}
                {c.status !== "revoked" && (
                  <button
                    className="button quiet danger"
                    disabled={busy === c.id}
                    onClick={() =>
                      run(async () => {
                        await api(
                          `/connectors/connections/${c.id}/revoke`,
                          "POST",
                          {},
                        );
                        await load();
                        notify(
                          "Connection revoked and its credential destroyed.",
                        );
                      })
                    }
                  >
                    <Trash size={15} />
                    Revoke
                  </button>
                )}
              </div>
            </div>
          );
        })}

      {modal === "create" && (
        <Modal title="New connection" close={() => setModal("")}>
          <form className="form" onSubmit={submit(create)}>
            <Field label="Provider">
              <select
                name="provider_key"
                value={providerKey}
                onChange={(e) => setProviderKey(e.target.value)}
                required
              >
                <option value="">Choose a provider</option>
                {providers
                  .filter((p) => p.implemented)
                  .map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.display_name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Label">
              <input name="label" required maxLength={120} autoFocus />
            </Field>
            {selected && (
              <>
                {ownershipOptions.length ? (
                  <Field label="Ownership">
                    <select name="ownership" required>
                      {ownershipOptions.map((o) => (
                        <option key={o} value={o}>
                          {o === "user"
                            ? "Delegated to me"
                            : "Shared with the workspace"}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <p className="muted small-text">
                    This provider only supports shared connections, which need
                    an owner or administrator.
                  </p>
                )}
                <fieldset className="field">
                  <span>Capabilities requested</span>
                  {selected.capabilities.map((cap) => (
                    <label className="checkbox-line" key={cap}>
                      <input
                        type="checkbox"
                        name="capabilities"
                        value={cap}
                        defaultChecked
                      />
                      {cap}
                    </label>
                  ))}
                </fieldset>
                <Field label="Configuration (JSON, optional)">
                  <textarea
                    name="config"
                    rows={3}
                    spellCheck={false}
                    placeholder='{"mailbox":"inbox"}'
                  />
                </Field>
                <p className="muted small-text">
                  No secret is entered here. You supply the credential on the
                  next step, after the connection exists.
                </p>
              </>
            )}
            <button
              className="button primary"
              disabled={!selected || !ownershipOptions.length}
            >
              Create connection
            </button>
          </form>
        </Modal>
      )}

      {(modal === "connect" || modal === "rotate") && active && (
        <Modal
          title={
            modal === "connect"
              ? `Connect ${active.label}`
              : `Rotate credential for ${active.label}`
          }
          close={() => {
            setModal("");
            setActive(null);
          }}
        >
          <form
            className="form"
            onSubmit={submit((form) =>
              supplySecret(form, modal === "connect" ? "connect" : "rotate"),
            )}
          >
            <Field label="Credential (an operator-supplied token or secret)">
              <input
                name="secret"
                type="password"
                required
                minLength={16}
                maxLength={4096}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <p className="muted small-text">
              The secret is sealed server-side and is never shown again. The API
              never returns it, and it is not kept anywhere in this page.
            </p>
            {active.provider_implemented && (
              <p className="muted small-text">
                This provider expects a{" "}
                {(
                  providers.find((p) => p.key === active.provider_key)
                    ?.credential_kinds || []
                ).join(" or ") || "credential"}
                .
              </p>
            )}
            <button className="button primary">
              {modal === "connect" ? "Connect" : "Rotate credential"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
