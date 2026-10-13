"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  Plus,
  RefreshCw,
  Play,
  Power,
  PowerOff,
  Trash,
} from "lucide-react";
import { api, run, notify } from "../lib/api";
import { Modal, Field, Empty } from "./common";

type WorkflowSummary = {
  id: string;
  name: string;
  description: string;
  status: string;
  authority: string;
  revision: number;
  published_revision: number | null;
  trigger: { type: string; label: string; summary: string };
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run: {
    id: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    error_category: string | null;
  } | null;
};

type PlannedStep = {
  seq: number;
  step_type: string;
  operation: string;
  node_id: string;
};

type WorkflowDetail = {
  workflow: WorkflowSummary;
  draft_definition: any;
  published: { revision: number; definition: any } | null;
  plan: PlannedStep[];
};

type RunSummary = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  revision: number;
  trigger_type: string;
  status: string;
  error_category: string | null;
  step_count: number;
  current_step: number;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
};

type StepRecord = {
  seq: number;
  step_type: string;
  operation: string;
  status: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  error_category: string | null;
  result: any;
  retry_state: any;
};

// A manual trigger with one delay action. It validates against the frozen
// contract on its own and needs no resource or connection, so it is a safe
// starting point a member can edit.
const STARTER = {
  schema_version: 1,
  trigger: { id: "trigger-1", type: "manual" },
  conditions: [],
  actions: [
    { id: "action-1", operation: "workflow.delay", config: { seconds: 1 } },
  ],
};

const label = (value: string) => value.replace(/_/g, " ");

function describePlan(plan: PlannedStep[] | undefined): string {
  if (!plan || !plan.length) return "";
  return plan
    .map((step) => `${step.seq}. ${step.operation} (${step.step_type})`)
    .join(" · ");
}

export default function Automations({ me }: { me: any }) {
  const [catalog, setCatalog] = useState<any>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [view, setView] = useState<"workflows" | "runs">("workflows");
  const [modal, setModal] = useState("");
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [definitionText, setDefinitionText] = useState("");
  const [planText, setPlanText] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runFilter, setRunFilter] = useState("");
  const [runDetail, setRunDetail] = useState<{
    run: RunSummary;
    steps: StepRecord[];
  } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [cat, list] = await Promise.all([
        api("/automations/catalog"),
        api("/automations/workflows"),
      ]);
      setCatalog(cat);
      setWorkflows(list.workflows || []);
      setError("");
    } catch (e) {
      setError((e as Error).message || "Automations could not be loaded.");
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

  async function loadRuns(workflowId = runFilter) {
    const query = workflowId
      ? `?workflow_id=${encodeURIComponent(workflowId)}&limit=50`
      : "?limit=50";
    const r = await api("/automations/runs" + query);
    setRuns(r.runs || []);
  }

  function parseDefinition(): any | undefined {
    try {
      return JSON.parse(definitionText);
    } catch {
      notify("Definition must be valid JSON.");
      return undefined;
    }
  }

  async function create(form: HTMLFormElement) {
    const definition = parseDefinition();
    if (definition === undefined) return;
    const data = new FormData(form);
    await api("/automations/workflows", "POST", {
      name: String(data.get("name") || "").trim(),
      description: String(data.get("description") || "").trim(),
      definition,
    });
    await load();
    setModal("");
    notify("Workflow created as a draft. Enable it to start it running.");
  }

  async function openEdit(id: string) {
    setBusy(id);
    try {
      const d = (await api(`/automations/workflows/${id}`)) as WorkflowDetail;
      setDetail(d);
      setDefinitionText(JSON.stringify(d.draft_definition, null, 2));
      setPlanText(describePlan(d.plan));
      setModal("edit");
    } finally {
      setBusy("");
    }
  }

  async function validateWorkflow(id: string) {
    const definition = parseDefinition();
    if (definition === undefined) return;
    const r = await api(`/automations/workflows/${id}/validate`, "POST", {
      definition,
    });
    setPlanText(describePlan(r.plan));
    notify("Definition is valid.");
  }

  async function saveDraft(id: string) {
    const definition = parseDefinition();
    if (definition === undefined) return;
    const r = await api(`/automations/workflows/${id}`, "PATCH", {
      definition,
    });
    setPlanText(describePlan(r.plan));
    await load();
    notify("Draft saved as a new revision.");
  }

  async function removeWorkflow(w: WorkflowSummary) {
    if (
      !window.confirm(
        `Delete the workflow "${w.name}"? Its run history is deleted with it.`,
      )
    )
      return;
    await api(`/automations/workflows/${w.id}`, "DELETE");
    await load();
    notify("Workflow deleted.");
  }

  async function showRuns(workflowId: string) {
    setRunFilter(workflowId);
    setView("runs");
    await loadRuns(workflowId);
  }

  async function openRun(id: string) {
    setBusy(id);
    try {
      const d = (await api(`/automations/runs/${id}`)) as {
        run: RunSummary;
        steps: StepRecord[];
      };
      setRunDetail(d);
      setModal("run");
    } finally {
      setBusy("");
    }
  }

  const limits = catalog?.limits || {};
  const catalogTriggers: { type: string; label: string; summary: string }[] =
    catalog?.triggers || [];
  const catalogActions: {
    key: string;
    display_name: string;
    kind: string;
    retryable: boolean;
  }[] = catalog?.actions || [];
  const catalogOperators: string[] = catalog?.operators || [];

  return (
    <section className="settings-section">
      <div className="section-title">
        <div>
          <h2>Automations</h2>
          <p className="muted">
            Workflows that run a trigger, then conditions, then actions before
            this workspace. They run entirely inside Workspace and do not
            require an external connection.
          </p>
        </div>
        <div className="automations-actions">
          <button className="button" onClick={() => run(() => showRuns(""))}>
            <Activity size={15} />
            Run history
          </button>
          <button
            className="button primary"
            onClick={() => {
              setDefinitionText(JSON.stringify(STARTER, null, 2));
              setPlanText("");
              setModal("create");
            }}
          >
            <Plus size={15} />
            New workflow
          </button>
        </div>
      </div>

      <details className="automations-reference">
        <summary>Catalog reference</summary>
        <p className="muted small-text">
          Triggers:{" "}
          {catalogTriggers.map((t) => t.type).join(", ") || "not loaded"}
        </p>
        <p className="muted small-text">
          Actions: {catalogActions.map((a) => a.key).join(", ") || "not loaded"}
        </p>
        <p className="muted small-text">
          Condition operators: {catalogOperators.join(", ") || "not loaded"}
        </p>
        <p className="muted small-text">
          Limits:{" "}
          {Object.entries(limits)
            .map(([key, value]) => `${key} ${value}`)
            .join(", ") || "not loaded"}
        </p>
      </details>

      {error && (
        <div role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => run(load)}>
            Try again
          </button>
        </div>
      )}

      {view === "workflows" && (
        <>
          {loading && <p className="muted">Loading workflows…</p>}
          {!loading && !error && workflows.length === 0 && (
            <Empty title="No workflows yet.">
              <p>
                Automations run inside Workspace and need no external
                connection. Create one to get started.
              </p>
            </Empty>
          )}
          {!loading &&
            workflows.map((w) => (
              <div className="integration-row" key={w.id}>
                <div>
                  <strong>{w.name}</strong>
                  <small>
                    {w.trigger?.label || w.trigger?.type} ·{" "}
                    <span className={"tag automations-status-" + w.status}>
                      {label(w.status)}
                    </span>{" "}
                    · revision {w.revision} ·{" "}
                    {w.published_revision
                      ? `published ${w.published_revision}`
                      : "not published"}
                  </small>
                  {w.trigger?.summary && (
                    <p className="small-text muted">{w.trigger.summary}</p>
                  )}
                  {w.description && (
                    <p className="small-text muted">{w.description}</p>
                  )}
                  <p className="small-text muted">
                    {w.last_run
                      ? `Last run ${label(w.last_run.status)}${
                          w.last_run.started_at
                            ? " started " +
                              new Date(w.last_run.started_at).toLocaleString()
                            : ""
                        }${w.last_run.error_category ? ` (${w.last_run.error_category})` : ""}`
                      : "No runs yet."}
                  </p>
                </div>
                <div className="automations-actions">
                  <button
                    className="button"
                    disabled={busy === w.id}
                    onClick={() => run(() => openEdit(w.id))}
                  >
                    Edit
                  </button>
                  <button
                    className="button"
                    disabled={busy === w.id}
                    onClick={() =>
                      run(async () => {
                        await api(
                          `/automations/workflows/${w.id}/run`,
                          "POST",
                          {},
                        );
                        await load();
                        notify("Run queued.");
                      })
                    }
                  >
                    <Play size={15} />
                    Run now
                  </button>
                  {w.status === "enabled" ? (
                    <button
                      className="button"
                      disabled={busy === w.id}
                      onClick={() =>
                        run(async () => {
                          const r = await api(
                            `/automations/workflows/${w.id}/disable`,
                            "POST",
                            {},
                          );
                          await load();
                          notify(
                            `Workflow disabled. Queued runs cancelled: ${
                              r.cancelled_queued_runs ?? 0
                            }.`,
                          );
                        })
                      }
                    >
                      <PowerOff size={15} />
                      Disable
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={busy === w.id}
                      onClick={() =>
                        run(async () => {
                          await api(
                            `/automations/workflows/${w.id}/enable`,
                            "POST",
                            {},
                          );
                          await load();
                          notify(
                            "Workflow enabled. The current draft is published.",
                          );
                        })
                      }
                    >
                      <Power size={15} />
                      Enable
                    </button>
                  )}
                  <button
                    className="button"
                    disabled={busy === w.id}
                    onClick={() => run(() => showRuns(w.id))}
                  >
                    Runs
                  </button>
                  <button
                    className="button quiet danger"
                    disabled={busy === w.id}
                    onClick={() => run(() => removeWorkflow(w))}
                  >
                    <Trash size={15} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
        </>
      )}

      {view === "runs" && (
        <>
          <div className="section-title">
            <h2>Run history</h2>
            <div className="automations-actions">
              <select
                aria-label="Filter runs by workflow"
                value={runFilter}
                onChange={(e) =>
                  run(async () => {
                    setRunFilter(e.target.value);
                    await loadRuns(e.target.value);
                  })
                }
              >
                <option value="">All workflows</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <button className="button" onClick={() => run(() => loadRuns())}>
                <RefreshCw size={15} />
                Refresh
              </button>
              <button className="button" onClick={() => setView("workflows")}>
                Back to workflows
              </button>
            </div>
          </div>
          {runs.length === 0 ? (
            <p className="muted">No runs recorded.</p>
          ) : (
            <div className="table-scroll">
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Workflow</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Step</th>
                    <th>Duration</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {new Date(
                          r.started_at || r.created_at,
                        ).toLocaleString()}
                      </td>
                      <td>{r.workflow_name}</td>
                      <td>{r.trigger_type}</td>
                      <td>
                        <span className={"tag automations-status-" + r.status}>
                          {label(r.status)}
                        </span>
                      </td>
                      <td>
                        {r.current_step}/{r.step_count}
                      </td>
                      <td>
                        {r.duration_ms !== null && r.duration_ms !== undefined
                          ? `${Math.round(r.duration_ms)} ms`
                          : "not finished"}
                      </td>
                      <td>
                        <button
                          className="button small-button"
                          disabled={busy === r.id}
                          onClick={() => run(() => openRun(r.id))}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {modal === "create" && (
        <Modal wide title="New workflow" close={() => setModal("")}>
          <form className="form" onSubmit={submit(create)}>
            <Field label="Name">
              <input name="name" required maxLength={200} autoFocus />
            </Field>
            <Field label="Description (optional)">
              <input name="description" maxLength={2000} />
            </Field>
            <Field label="Definition (JSON)">
              <textarea
                aria-label="Workflow definition"
                value={definitionText}
                onChange={(e) => setDefinitionText(e.target.value)}
                rows={14}
                spellCheck={false}
              />
            </Field>
            <p className="muted small-text">
              Replace the placeholder ids, condition paths and action config
              with what this workflow should do. Unknown keys, operations or
              values outside the limits are rejected when you create or
              validate.
            </p>
            <button className="button primary">Create workflow</button>
          </form>
        </Modal>
      )}

      {modal === "edit" && detail && (
        <Modal
          wide
          title={`Edit ${detail.workflow.name}`}
          close={() => setModal("")}
        >
          <div className="form">
            <p className="muted small-text">
              Saving stores a new immutable revision. A run that already started
              keeps the revision it began with.
              {detail.published
                ? ` Published revision ${detail.published.revision}.`
                : " This workflow is not published yet."}
            </p>
            <Field label="Definition (JSON)">
              <textarea
                aria-label="Workflow definition"
                value={definitionText}
                onChange={(e) => setDefinitionText(e.target.value)}
                rows={16}
                spellCheck={false}
              />
            </Field>
            {planText && (
              <p className="automations-plan" role="status">
                Plan: {planText}
              </p>
            )}
            <div className="automations-actions">
              <button
                type="button"
                className="button"
                onClick={() => run(() => validateWorkflow(detail.workflow.id))}
              >
                Validate
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => run(() => saveDraft(detail.workflow.id))}
              >
                Save draft
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === "run" && runDetail && (
        <Modal
          wide
          title={`Run ${runDetail.run.id.slice(0, 8)}`}
          close={() => {
            setModal("");
            setRunDetail(null);
          }}
        >
          <div className="form">
            <p className="muted small-text">
              {runDetail.run.workflow_name} · revision {runDetail.run.revision}{" "}
              · trigger {runDetail.run.trigger_type} · status{" "}
              {label(runDetail.run.status)}
              {runDetail.run.error_category
                ? ` · error ${runDetail.run.error_category}`
                : ""}
            </p>
            <div className="table-scroll">
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>Operation</th>
                    <th>Status</th>
                    <th>Attempt</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runDetail.steps.map((s) => (
                    <tr key={s.seq + ":" + s.attempt}>
                      <td>{s.seq}</td>
                      <td>{s.step_type}</td>
                      <td>
                        <code>{s.operation}</code>
                      </td>
                      <td>
                        <span className={"tag automations-status-" + s.status}>
                          {label(s.status)}
                        </span>
                      </td>
                      <td>{s.attempt}</td>
                      <td>
                        {s.started_at
                          ? new Date(s.started_at).toLocaleString()
                          : ""}
                      </td>
                      <td>
                        {s.completed_at
                          ? new Date(s.completed_at).toLocaleString()
                          : ""}
                      </td>
                      <td>{s.error_category || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="automations-actions">
              {["queued", "running", "waiting"].includes(
                runDetail.run.status,
              ) && (
                <button
                  type="button"
                  className="button"
                  disabled={busy === runDetail.run.id}
                  onClick={() =>
                    run(async () => {
                      await api(
                        `/automations/runs/${runDetail.run.id}/cancel`,
                        "POST",
                        {},
                      );
                      await openRun(runDetail.run.id);
                      await loadRuns();
                      notify("Run cancelled.");
                    })
                  }
                >
                  Cancel run
                </button>
              )}
              {["failed", "dead_letter"].includes(runDetail.run.status) && (
                <button
                  type="button"
                  className="button"
                  disabled={busy === runDetail.run.id}
                  onClick={() =>
                    run(async () => {
                      await api(
                        `/automations/runs/${runDetail.run.id}/retry`,
                        "POST",
                        {},
                      );
                      await openRun(runDetail.run.id);
                      await loadRuns();
                      notify("Run queued for retry.");
                    })
                  }
                >
                  Retry run
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
