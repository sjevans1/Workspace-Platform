"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  Table2,
  Columns3,
  SlidersHorizontal,
  Filter,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api, run, notify, go, changed } from "../lib/api";
import { Modal, Field, Empty } from "./common";
export function PropertyInput({
  p,
  value,
  members = [],
  disabled = false,
  save,
  databaseId,
}: {
  p: any;
  value: any;
  members?: any[];
  disabled?: boolean;
  databaseId?: string;
  save: (v: any) => void;
}) {
  if (p.type === "rollup")
    return <output aria-label={p.name} className="rollup-result">
      {value === null || value === undefined ? "—" : String(value)}
    </output>;
  if (p.type === "formula")
    return <output aria-label={p.name} className="formula-result">
      {value === null || value === undefined ? "—" : String(value)}
    </output>;
  if (p.type === "relation")
    return <RelationInput p={p} value={value} disabled={disabled}
      save={save} databaseId={databaseId} />;
  if (p.type === "checkbox")
    return (
      <input
        aria-label={p.name}
        type="checkbox"
        checked={!!value}
        disabled={disabled}
        onChange={(e) => save(e.target.checked)}
      />
    );
  if (["select", "status", "person", "multi_select"].includes(p.type)) {
    const options =
      p.type === "person"
        ? members
            .filter((m) => m.active && !m.is_service)
            .map((m) => ({ id: m.id, name: m.name }))
        : (p.options || []).map((x: string) => ({ id: x, name: x }));
    return (
      <select
        className={
          p.type === "status"
            ? `status-select status-${String(value).replaceAll(" ", "-").toLowerCase()}`
            : ""
        }
        aria-label={p.name}
        value={p.type === "multi_select" ? value || [] : value || ""}
        multiple={p.type === "multi_select"}
        disabled={disabled}
        onChange={(e) =>
          save(
            p.type === "multi_select"
              ? Array.from(e.target.selectedOptions).map((o) => o.value)
              : e.target.value || null,
          )
        }
      >
        {p.type !== "multi_select" && <option value="">—</option>}
        {options.map((o: any) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      key={JSON.stringify(value)}
      aria-label={p.name}
      type={
        (
          {
            number: "number",
            date: "date",
            email: "email",
            url: "url",
          } as Record<string, string>
        )[p.type] || "text"
      }
      step={p.type === "number" ? "any" : undefined}
      defaultValue={value ?? ""}
      disabled={disabled}
      placeholder="—"
      onChange={
        p.type === "date"
          ? (e) => {
              const next = e.currentTarget.value || null;
              if (next !== (value ?? null)) save(next);
            }
          : undefined
      }
      onBlur={(e) => {
        // A native date selection may retain focus. Persist changes as soon
        // as the browser commits the date instead of relying on blur alone.
        if (p.type === "date") return;
        const v = e.target.value
          ? p.type === "number"
            ? Number(e.target.value)
            : e.target.value
          : null;
        if (v !== (value ?? null)) save(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
function RelationInput({
  p, value, disabled, save, databaseId,
}: {
  p: any; value: any; disabled: boolean; save: (value: any) => void;
  databaseId?: string;
}) {
  const ids: string[] = Array.isArray(value) ? value : [];
  const [labels, setLabels] = useState<Record<string, string>>({}),
    [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [choices, setChoices] = useState<any[]>([]),
    [more, setMore] = useState(false),
    [error, setError] = useState("");
  const idsKey = ids.join(",");
  useEffect(() => {
    if (!databaseId || !p.target_database_id || !idsKey) {
      setLabels({});
      return;
    }
    let canceled = false;
    void api(`/databases/${databaseId}/relation-candidates?property=${encodeURIComponent(p.id)}&selected=${encodeURIComponent(idsKey)}`)
      .then((result) => {
        if (!canceled) setLabels(Object.fromEntries(
          result.items.map((record: any) => [record.id, record.title])));
      })
      .catch(() => { if (!canceled) setLabels({}); });
    return () => { canceled = true; };
  }, [databaseId, p.target_database_id, p.id, idsKey]);
  useEffect(() => {
    if (!open || !databaseId || !p.target_database_id) return;
    let canceled = false;
    void api(`/databases/${databaseId}/relation-candidates?property=${encodeURIComponent(p.id)}&search=${encodeURIComponent(search)}&offset=${offset}`)
      .then((result) => {
        if (!canceled) {
          setChoices(result.items);
          setMore(result.has_more);
          setError("");
        }
      })
      .catch(() => {
        if (!canceled) { setError("Unable to load permitted records"); setChoices([]); }
      });
    return () => { canceled = true; };
  }, [open, databaseId, p.target_database_id, p.id, search, offset]);
  if (!p.target_database_id)
    return <span className="muted">Related database unavailable</span>;
  return (
    <div className="relation-input" role="group" aria-label={p.name}>
      {ids.map((recordId) => (
        <span className="relation-chip" key={recordId}>
          <button type="button" disabled={!labels[recordId]}
            aria-label={`Open related record ${labels[recordId] || ""}`}
            onClick={() => go(recordId)}>
            {labels[recordId] || "Related record"}
          </button>
          {!disabled && <button type="button"
            aria-label={`Remove related record ${labels[recordId] || ""}`}
            onClick={() => save(ids.filter((id) => id !== recordId))}>×</button>}
        </span>
      ))}
      {!disabled && ids.length < 20 && <>
        <button type="button" aria-label={`Add related record for ${p.name}`}
          onClick={() => { setOpen(!open); setOffset(0); }}>
          {open ? "Close picker" : "Add relation"}
        </button>
        {open && <div className="relation-picker">
          <input aria-label={`Search related records for ${p.name}`}
            value={search} placeholder="Find an accessible record"
            onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          {error && <span role="alert">{error}</span>}
          {choices.filter((choice) => !ids.includes(choice.id)).map((choice) =>
            <button key={choice.id} type="button"
              aria-label={`Link record ${choice.title}`}
              onClick={() => { save([...ids, choice.id]); setOpen(false); }}>
              {choice.title}
            </button>)}
          {more && <button type="button"
            aria-label="More permitted related records"
            onClick={() => setOffset(offset + 20)}>More</button>}
        </div>}
      </>}
    </div>
  );
}

export default function Database({
  id,
  editable,
}: {
  id: string;
  editable: boolean;
}) {
  const [data, setData] = useState<any>(),
    [rows, setRows] = useState<any[]>([]),
    [members, setMembers] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [offset, setOffset] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [pageHasMore, setPageHasMore] = useState(false),
    [month, setMonth] = useState(() => {
      const today = new Date();
      return today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");
    }),
    [panel, setPanel] = useState(""),
    [name, setName] = useState("");
  const current =
    data?.views.find((v: any) => v.id === selected) || data?.views[0];
  async function load(viewId = selected, cursorOverride: string | null = cursor) {
    const d = await api(`/databases/${id}`);
    setData(d);
    const v = d.views.find((v: any) => v.id === viewId) || d.views[0];
    setSelected(v?.id || "");
    const size = v?.config.type === "calendar" ? 200 : 100;
    const argumentsPart = `limit=${size}${v ? `&view=${v.id}` : ""}${v?.config.type === "calendar" ? `&month=${month}` : ""}`;
    // Saved custom sort semantics require a typed keyset comparator.
    // Preserve the bounded legacy API for those views until W08 supports it.
    if (v?.config.sort?.length) {
      const older = await api(
        `/databases/${id}/records?${argumentsPart}&offset=${offset}`);
      setRows(older);
      setPageHasMore(older.length === size);
      setNextCursor(null);
    } else {
      const page = await api(
        `/databases/${id}/records/page?${argumentsPart}${cursorOverride ? `&cursor=${encodeURIComponent(cursorOverride)}` : ""}`);
      setRows(page.items);
      setPageHasMore(page.has_more);
      setNextCursor(page.next_cursor);
    }
  }
  useEffect(() => {
    run(async () => {
      await load();
      setMembers(await api("/members"));
    });
  }, [id, selected, offset, month, cursor]);
  if (!data) return <div className="loading">Opening database…</div>;
  const config = current?.config || { type: "table", filters: [], sort: [] };
  const props = (config.order || data.properties.map((p: any) => p.id))
    .map((k: string) => data.properties.find((p: any) => p.id === k))
    .filter(
      (p: any) => p && (!config.visible || config.visible.includes(p.id)),
    );
  async function save(row: any, property: string, value: any) {
    await run(async () => {
      await api(`/records/${row.id}`, "PATCH", {
        values: { [property]: value },
        expected_revision: row.revision,
      });
      await load();
      changed();
    });
  }
  async function switchType(type: string) {
    const v = data.views.find((v: any) => v.config.type === type);
    if (v) {
      setSelected(v.id);
      setOffset(0);
      setCursor(null);
      setCursorHistory([]);
      setNextCursor(null);
      return;
    }
    if (!editable) return notify("Only editors can create saved views");
    const group = data.properties.find((p: any) =>
      ["select", "status"].includes(p.type),
    );
    // For task databases, Due date is the useful initial calendar field.
    // Other schemas keep the first valid Date property as the fallback.
    const dateField =
      data.properties.find((p: any) => p.type === "date" && p.id === "due") ||
      data.properties.find((p: any) => p.type === "date");
    if (type === "board" && !group)
      return notify("Add a Select or Status property before creating a board");
    if (type === "calendar" && !dateField)
      return notify("Add a Date property before creating a calendar");
    const created = await api(`/databases/${id}/views`, "POST", {
      name: type === "board" ? "Board" : type === "calendar" ? "Calendar" : "Table",
      config: {
        type,
        ...(type === "board" ? { groupBy: group.id } : {}),
        ...(type === "calendar" ? { dateBy: dateField.id } : {}),
        filters: [],
        sort: [],
      },
    });
    setOffset(0);
    setCursor(null);
    setCursorHistory([]);
    setNextCursor(null);
    setSelected(created.id);
  }
  const group = data.properties.find((p: any) => p.id === config.groupBy),
    groups = [...(group?.options || []), ""],
    [year, monthNumber] = month.split("-").map(Number),
    firstDay = new Date(Date.UTC(year, monthNumber - 1, 1)),
    dayOffset = firstDay.getUTCDay(),
    totalDays = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(),
    calendarDays = Array.from(
      { length: Math.ceil((dayOffset + totalDays) / 7) * 7 },
      (_, i) => i - dayOffset + 1,
    ),
    monthLabel = firstDay.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  function changeMonth(delta: number) {
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
    setMonth(
      shifted.getUTCFullYear() +
        "-" +
        String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    );
    setOffset(0);
    setCursor(null);
    setCursorHistory([]);
    setNextCursor(null);
  }
  return (
    <div className="database">
      <div className="database-toolbar">
        <div className="view-tabs">
          <button
            className={config.type === "table" ? "selected" : ""}
            onClick={() => run(() => switchType("table"))}
          >
            <Table2 size={16} />
            Table
          </button>
          <button
            className={config.type === "board" ? "selected" : ""}
            onClick={() => run(() => switchType("board"))}
          >
            <Columns3 size={16} />
            Board
          </button>
          <button
            className={config.type === "calendar" ? "selected" : ""}
            onClick={() => run(() => switchType("calendar"))}
          >
            <CalendarDays size={16} />
            Calendar
          </button>
        </div>
        <select
          className="view-select"
          aria-label="Saved view"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setOffset(0);
            setCursor(null);
            setCursorHistory([]);
            setNextCursor(null);
          }}
        >
          {data.views.map((v: any) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <div className="database-controls">
          <button className="button quiet" onClick={() => setPanel("view")}>
            <Filter size={14} />
            Filter & sort
            {config.filters.length ? ` (${config.filters.length})` : ""}
          </button>
          <button
            className="icon-button"
            aria-label="Configure properties"
            onClick={() => setPanel("properties")}
          >
            <SlidersHorizontal size={17} />
          </button>
          {editable && (
            <button
              className="button primary small-button"
              onClick={() => setPanel("new")}
            >
              <Plus size={15} />
              New record
            </button>
          )}
        </div>
      </div>
      {config.type === "calendar" ? (
        <div className="database-calendar">
          <div className="calendar-toolbar">
            <h3>{monthLabel}</h3>
            <div className="calendar-navigation">
              <button className="button" aria-label="Previous month" onClick={() => changeMonth(-1)}>
                <ChevronLeft size={17} />
              </button>
              <button className="button" onClick={() => {
                const now = new Date();
                setMonth(now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"));
                setOffset(0);
                setCursor(null);
                setCursorHistory([]);
                setNextCursor(null);
              }}>Today</button>
              <button className="button" aria-label="Next month" onClick={() => changeMonth(1)}>
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          <div className="calendar-weekdays" aria-hidden="true">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid" aria-label={monthLabel + " calendar"}>
            {calendarDays.map((day, index) => {
              if (day < 1 || day > totalDays)
                return <div className="calendar-day outside" key={index} aria-hidden="true" />;
              const date = month + "-" + String(day).padStart(2, "0"),
                dayRecords = rows.filter((row) => row.values?.[config.dateBy] === date);
              return (
                <section className="calendar-day" key={date} aria-label={date}>
                  <time dateTime={date}>{day}</time>
                  {dayRecords.map((row) => (
                    <button
                      className="calendar-event"
                      key={row.id}
                      title={row.title}
                      onClick={() => go(row.id)}
                    >
                      {row.title}
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
          {!rows.length && (
            <p className="calendar-empty muted">No records dated in {monthLabel}.</p>
          )}
        </div>
      ) : config.type === "board" ? (
        <div className="board">
          {groups.map((status: string) => (
            <section
              key={status}
              className="board-column"
              onDragOver={(e) => editable && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const row = rows.find(
                  (r) => r.id === e.dataTransfer.getData("text/plain"),
                );
                if (row && editable) save(row, group.id, status || null);
              }}
            >
              <header>
                <span
                  className={`status-dot status-${status.replaceAll(" ", "-").toLowerCase()}`}
                />
                <strong>{status || "No status"}</strong>
                <span>
                  {
                    rows.filter((r) => (r.values[group?.id] || "") === status)
                      .length
                  }
                </span>
              </header>
              {rows
                .filter((r) => (r.values[group?.id] || "") === status)
                .map((row) => (
                  <article
                    className="board-card"
                    draggable={editable}
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/plain", row.id)
                    }
                    key={row.id}
                  >
                    <button
                      className="board-card-title"
                      onClick={() => go(row.id)}
                    >
                      {row.title}
                      <ArrowUpRight size={14} />
                    </button>
                    {props
                      .filter((p: any) => p.type !== "title")
                      .map((p: any) => (
                        <div className="board-property" key={p.id}>
                          <small>{p.name}</small>
                          <PropertyInput
                            p={p}
                            value={row.values[p.id]}
                            members={members}
                            databaseId={id}
                            disabled={!editable}
                            save={(value) => save(row, p.id, value)}
                          />
                        </div>
                      ))}
                  </article>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="record-table">
            <thead>
              <tr>
                {props.map((p: any) => (
                  <th
                    key={p.id}
                    style={{
                      minWidth:
                        config.widths?.[p.id] ||
                        (p.type === "title" ? 280 : 155),
                    }}
                  >
                    <span className="property-type">
                      {p.type === "title"
                        ? "Aa"
                        : p.type === "date"
                          ? "◷"
                          : p.type === "number"
                            ? "#"
                            : "•"}
                    </span>
                    {p.name}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {props.map((p: any) => (
                    <td key={p.id}>
                      <div className="cell-content">
                        <PropertyInput
                          p={p}
                          value={row.values[p.id]}
                          members={members}
                          databaseId={id}
                          disabled={!editable}
                          save={(value) => save(row, p.id, value)}
                        />
                        {p.type === "title" && (
                          <button
                            className="cell-open"
                            aria-label={`Open ${row.title}`}
                            onClick={() => go(row.id)}
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  ))}
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Open record ${row.title}`}
                      onClick={() => go(row.id)}
                    >
                      <ArrowUpRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <Empty title="Make the first move.">
              <p>Add a record to start tracking your work.</p>
            </Empty>
          )}
          {editable && (
            <button className="table-add" onClick={() => setPanel("new")}>
              <Plus size={15} />
              New record
            </button>
          )}
        </div>
      )}
      <div className="table-footer">
        <span>
          {rows.length} records · {offset + (rows.length ? 1 : 0)}–{offset + rows.length}
        </span>
        <button
          disabled={config.sort?.length ? !offset : cursorHistory.length === 0}
          onClick={() => {
            if (config.sort?.length) {
              setOffset((v) => Math.max(0,
                v - (config.type === "calendar" ? 200 : 100)));
            } else {
              setCursor(cursorHistory.at(-1) || null);
              setCursorHistory((history) => history.slice(0, -1));
              setOffset((v) => Math.max(0,
                v - (config.type === "calendar" ? 200 : 100)));
            }
          }}
        >
          Previous
        </button>
        <button
          disabled={config.sort?.length ? !pageHasMore : !nextCursor}
          onClick={() => {
            if (!config.sort?.length) {
              setCursorHistory((history) => [...history, cursor]);
              setCursor(nextCursor);
            }
            setOffset((v) => v + (config.type === "calendar" ? 200 : 100));
          }}
        >
          Next
        </button>
      </div>
      {panel === "new" && (
        <Modal title="New record" close={() => setPanel("")}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const title = data.properties.find(
                  (p: any) => p.type === "title",
                );
                await api(`/databases/${id}/records`, "POST", {
                  values: { [title.id]: name },
                });
                setName("");
                setPanel("");
                await load();
                changed();
              });
            }}
          >
            <Field label="Name">
              <input
                autoFocus
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <button className="button primary">Create record</button>
          </form>
        </Modal>
      )}
      {panel === "view" && (
        <ViewDialog
          data={data}
          view={current}
          editable={editable}
          close={() => setPanel("")}
          done={async (v) => {
            setOffset(0);
            setCursor(null);
            setCursorHistory([]);
            setNextCursor(null);
            setSelected(v);
            await load(v, null);
            setPanel("");
          }}
        />
      )}
      {panel === "properties" && (
        <PropertiesDialog
          data={data}
          view={current}
          editable={editable}
          close={() => setPanel("")}
          done={async () => {
            await load();
            setPanel("");
          }}
        />
      )}
    </div>
  );
}
function ViewDialog({
  data,
  view,
  editable,
  close,
  done,
}: {
  data: any;
  view: any;
  editable: boolean;
  close: () => void;
  done: (v: string) => Promise<void>;
}) {
  const [name, setName] = useState(view.name),
    [config, setConfig] = useState(view.config),
    [copy, setCopy] = useState(false);
  return (
    <Modal title="View settings" close={close}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const v = await api(
              `/databases/${data.id}/views${copy ? "" : `/${view.id}`}`,
              copy ? "POST" : "PATCH",
              { name, config },
            );
            await done(v.id);
          });
        }}
      >
        <Field label="View name">
          <input
            value={name}
            disabled={!editable}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {config.type === "calendar" && (
          <Field label="Calendar date property">
            <select
              value={config.dateBy || ""}
              disabled={!editable}
              onChange={(e) => setConfig({ ...config, dateBy: e.target.value })}
            >
              {data.properties
                .filter((p: any) => p.type === "date")
                .map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
          </Field>
        )}
        {config.type === "board" && (
          <Field label="Group by">
            <select
              value={config.groupBy}
              disabled={!editable}
              onChange={(e) =>
                setConfig({ ...config, groupBy: e.target.value })
              }
            >
              {data.properties
                .filter((p: any) => ["status", "select"].includes(p.type))
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <h3>Filters</h3>
        {config.filters.map((f: any, i: number) => (
          <div className="filter-row" key={i}>
            <select
              aria-label="Filter property"
              disabled={!editable}
              value={f.property}
              onChange={(e) =>
                setConfig({
                  ...config,
                  filters: config.filters.map((v: any, j: number) =>
                    i === j ? { ...v, property: e.target.value } : v,
                  ),
                })
              }
            >
              {data.properties.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter operator"
              disabled={!editable}
              value={f.op}
              onChange={(e) =>
                setConfig({
                  ...config,
                  filters: config.filters.map((v: any, j: number) =>
                    i === j ? { ...v, op: e.target.value } : v,
                  ),
                })
              }
            >
              {["eq", "contains", "before", "after", "empty"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              aria-label="Filter value"
              disabled={!editable || f.op === "empty"}
              value={f.value || ""}
              onChange={(e) =>
                setConfig({
                  ...config,
                  filters: config.filters.map((v: any, j: number) =>
                    i === j ? { ...v, value: e.target.value } : v,
                  ),
                })
              }
            />
            {editable && (
              <button
                type="button"
                className="icon-button"
                onClick={() =>
                  setConfig({
                    ...config,
                    filters: config.filters.filter(
                      (_: any, j: number) => i !== j,
                    ),
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
        {editable && (
          <button
            type="button"
            className="button"
            onClick={() =>
              setConfig({
                ...config,
                filters: [
                  ...config.filters,
                  {
                    property: data.properties[0].id,
                    op: "contains",
                    value: "",
                  },
                ],
              })
            }
          >
            Add filter
          </button>
        )}
        <h3>Sort</h3>
        <div className="form-grid">
          <select
            aria-label="Sort property"
            disabled={!editable}
            value={config.sort[0]?.property || ""}
            onChange={(e) =>
              setConfig({
                ...config,
                sort: e.target.value
                  ? [
                      {
                        property: e.target.value,
                        direction: config.sort[0]?.direction || "asc",
                      },
                    ]
                  : [],
              })
            }
          >
            <option value="">Manual order</option>
            {data.properties.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort direction"
            disabled={!editable || !config.sort.length}
            value={config.sort[0]?.direction || "asc"}
            onChange={(e) =>
              setConfig({
                ...config,
                sort: [{ ...config.sort[0], direction: e.target.value }],
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
        {editable && (
          <>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={copy}
                onChange={(e) => setCopy(e.target.checked)}
              />
              Save as a new view
            </label>
            <button className="button primary">Save view</button>
          </>
        )}
      </form>
    </Modal>
  );
}
function RollupPropertyEditor({
  p, properties, disabled, onChange,
}: {
  p: any; properties: any[]; disabled: boolean;
  onChange: (values: Record<string, any>) => void;
}) {
  const relations = properties.filter((field) => field.type === "relation");
  const chosen = relations.find((field) => field.id === p.rollup_relation_id);
  const [numericFields, setNumericFields] = useState<any[]>([]);
  useEffect(() => {
    const id = chosen?.target_database_id;
    if (!id || chosen.target_unavailable) { setNumericFields([]); return; }
    let cancelled = false;
    void api("/databases/" + id).then((data: any) => {
      if (!cancelled)
        setNumericFields((data.properties || []).filter(
          (field: any) => field.type === "number"));
    }).catch(() => { if (!cancelled) setNumericFields([]); });
    return () => { cancelled = true; };
  }, [chosen?.target_database_id, chosen?.target_unavailable]);
  if (!relations.length)
    return <span className="muted">
      Add a Relation property first, then choose it for this Rollup.
    </span>;
  return <div className="rollup-config">
    <label>
      Source Relation
      <select aria-label={`Rollup source relation for ${p.name}`}
        disabled={disabled}
        value={p.rollup_relation_id || ""}
        onChange={(event) => onChange({
          rollup_relation_id: event.target.value || undefined,
          rollup_value_property_id: undefined,
        })}>
        <option value="">Select Relation</option>
        {relations.filter((relation) => relation.target_database_id)
          .map((relation) =>
            <option value={relation.id} key={relation.id}>
              {relation.name}
            </option>)}
      </select>
    </label>
    <label>
      Aggregate operation
      <select aria-label={`Rollup operation for ${p.name}`}
        disabled={disabled || !chosen?.target_database_id}
        value={p.rollup_operation || "count"}
        onChange={(event) => onChange({
          rollup_operation: event.target.value,
          rollup_value_property_id: undefined,
        })}>
        {["count","sum","avg","min","max"].map((op) =>
          <option value={op} key={op}>{op}</option>)}
      </select>
    </label>
    {p.rollup_operation !== "count" &&
      <label>
        Numeric field of related record
        <select aria-label={`Rollup numeric field for ${p.name}`}
          disabled={disabled || !chosen?.target_database_id}
          value={p.rollup_value_property_id || ""}
          onChange={(event) => onChange({
            rollup_value_property_id: event.target.value || undefined,
          })}>
          <option value="">Choose permitted Number field</option>
          {numericFields.map((field) =>
            <option value={field.id} key={field.id}>{field.name}</option>)}
        </select>
      </label>}
    <small className="muted">
      Read-only. Counts and aggregates include only currently accessible
      linked records; hidden or deleted records never contribute.
    </small>
  </div>;
}

function PropertiesDialog({
  data,
  view,
  editable,
  close,
  done,
}: {
  data: any;
  view: any;
  editable: boolean;
  close: () => void;
  done: () => Promise<void>;
}) {
  const [props, setProps] = useState<any[]>(data.properties),
    [visible, setVisible] = useState<string[]>(
      view.config.visible || data.properties.map((p: any) => p.id),
    ),
    [widths, setWidths] = useState(view.config.widths || {}),
    [targetSearch, setTargetSearch] = useState(""),
    [targetOffset, setTargetOffset] = useState(0),
    [targetOptions, setTargetOptions] = useState<any[]>([]),
    [moreTargets, setMoreTargets] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api(`/databases/${data.id}/relation-targets?search=${encodeURIComponent(targetSearch)}&offset=${targetOffset}&limit=30`)
      .then((result) => {
        if (!canceled) {
          setTargetOptions(result.items);
          setMoreTargets(result.has_more);
        }
      })
      .catch(() => { if (!canceled) { setTargetOptions([]); setMoreTargets(false); } });
    return () => { canceled = true; };
  }, [data.id, targetSearch, targetOffset]);
  const update = (i: number, v: any) =>
    setProps((p) => p.map((x, j) => (i === j ? { ...x, ...v } : x)));
  return (
    <Modal title="Properties & columns" close={close} wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api(`/databases/${data.id}`, "PATCH", {
              properties: props.map(({ target_unavailable: _hidden, ...rest }) => rest),
            });
            await api(`/databases/${data.id}/views/${view.id}`, "PATCH", {
              name: view.name,
              config: {
                ...view.config,
                visible,
                order: props.map((p) => p.id),
                widths,
              },
            });
            await done();
          });
        }}
      >
        <p className="muted">
          Schema changes are checked against existing records. Select options
          are separated by commas.
        </p>
        {props.map((p, i) => (
          <div className="property-editor" key={p.id}>
            <input
              aria-label={`Show ${p.name}`}
              type="checkbox"
              checked={visible.includes(p.id)}
              disabled={!editable}
              onChange={(e) =>
                setVisible((v) =>
                  e.target.checked ? [...v, p.id] : v.filter((x) => x !== p.id),
                )
              }
            />
            <input
              aria-label="Property name"
              value={p.name}
              disabled={!editable}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <select
              aria-label="Property type"
              value={p.type}
              disabled={!editable || p.type === "title"}
              onChange={(e) =>
                update(i, {
                  type: e.target.value,
                  target_database_id: e.target.value === "relation"
                    ? p.target_database_id : undefined,
                  ...(["select", "status", "multi_select"].includes(
                    e.target.value,
                  )
                    ? { options: p.options || ["Option 1"] }
                    : { options: undefined }),
                  // Clear the numeric Formula when changing property type.
                  formula: e.target.value === "formula"
                    ? p.formula || "0" : undefined,
                  rollup_relation_id: e.target.value === "rollup"
                    ? p.rollup_relation_id ||
                      props.find((field) => field.type === "relation")?.id
                    : undefined,
                  rollup_operation: e.target.value === "rollup"
                    ? p.rollup_operation || "count" : undefined,
                  rollup_value_property_id: e.target.value === "rollup"
                    ? p.rollup_value_property_id : undefined,
                })
              }
            >
              {[
                "title",
                "text",
                "number",
                "select",
                "multi_select",
                "status",
                "date",
                "checkbox",
                "person",
                "url",
                "email",
                "relation",
                "formula",
                "rollup",
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input
              aria-label="Column width"
              type="number"
              min="80"
              max="900"
              value={widths[p.id] || 155}
              disabled={!editable}
              onChange={(e) =>
                setWidths({ ...widths, [p.id]: Number(e.target.value) })
              }
            />
            <button
              className="icon-button"
              type="button"
              disabled={!editable || !i}
              aria-label="Move property up"
              onClick={() =>
                setProps((v) => {
                  const a = [...v];
                  [a[i - 1], a[i]] = [a[i], a[i - 1]];
                  return a;
                })
              }
            >
              <ArrowUp size={15} />
            </button>
            {p.type === "relation" && (
              <div className="relation-target-selector">
                <label htmlFor={`relation-target-${p.id}`}>Related database</label>
                <input
                  aria-label="Search target databases"
                  placeholder="Find target database"
                  value={targetSearch}
                  onChange={(event) => {
                    setTargetSearch(event.target.value); setTargetOffset(0);
                  }}
                />
                <select id={`relation-target-${p.id}`}
                  aria-label={`Related database for ${p.name}`}
                  value={p.target_database_id || ""}
                  disabled={!editable || p.target_unavailable}
                  onChange={(event) =>
                    update(i, { target_database_id: event.target.value || undefined })
                  }
                >
                  <option value="">Choose a permitted database</option>
                  {p.target_database_id &&
                    !targetOptions.some((db) => db.id === p.target_database_id) &&
                    <option value={p.target_database_id}>Current permitted target</option>}
                  {targetOptions.map((database) =>
                    <option key={database.id} value={database.id}>{database.title}</option>)}
                </select>
                {moreTargets && <button type="button" className="button quiet"
                  onClick={() => setTargetOffset(targetOffset + 30)}>
                  More databases
                </button>}
                {p.target_unavailable &&
                  <span className="muted">Target inaccessible; contact an administrator.</span>}
              </div>
            )}
            {p.type === "rollup" && (
              <RollupPropertyEditor p={p} properties={props}
                disabled={!editable} onChange={(values) => update(i, values)} />
            )}
            {p.type === "formula" && (
              <div className="formula-config">
                <input aria-label={`${p.name} formula expression`}
                  value={p.formula || ""} disabled={!editable}
                  placeholder="[unit_cost] * [quantity]"
                  onChange={(e) => update(i, { formula: e.target.value })}
                />
                <small className="muted">
                  Insert a Number field below, then use +, -, *, / or parentheses.
                  Only fields from this database are available.
                </small>
                <div role="group" aria-label={`Number references for ${p.name}`}>
                  {props.filter((other) => other.type === "number").map((other) =>
                    <button key={other.id} type="button" className="button quiet"
                      disabled={!editable}
                      aria-label={`Insert number field ${other.name}`}
                      onClick={() => update(i, {
                        formula: (p.formula === "0" ? "" : p.formula || "") +
                          `[${other.id}]`,
                      })}>
                      {other.name}
                    </button>)}
                  {!props.some((other) => other.type === "number") &&
                    <span className="muted">
                      Add a Number property to reference it here.
                    </span>}
                </div>
              </div>
            )}
            {["select", "status", "multi_select"].includes(p.type) && (
              <input
                className="options-input"
                aria-label={`${p.name} options`}
                defaultValue={p.options?.join(", ") || ""}
                disabled={!editable}
                onBlur={(e) =>
                  update(i, {
                    options: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
          </div>
        ))}
        {editable && (
          <>
            <button
              className="button"
              type="button"
              onClick={() => {
                const p = {
                  id: `prop_${crypto.randomUUID().slice(0, 8)}`,
                  name: "New property",
                  type: "text",
                };
                setProps((v) => [...v, p]);
                setVisible((v) => [...v, p.id]);
              }}
            >
              Add property
            </button>
            <div className="modal-actions">
              <button className="button primary">Save properties</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
