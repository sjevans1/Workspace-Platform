"use client";
import { useEffect, useState } from "react";
import {
  Home,
  Search,
  Clock,
  Star,
  LayoutTemplate,
  Trash2,
  Settings as SettingsIcon,
  PanelLeft,
  Plus,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  LogOut,
  Upload,
  ArrowRight,
  Moon,
  Sun,
} from "lucide-react";
import { api, ApiError, setCsrf, notify, run, changed, go, icon, date } from "../lib/api";
import { Modal, Empty, Spinner, Field } from "./common";
import Resource from "./Resource";
import Settings from "./Settings";
import { useAppearance } from "../lib/appearance";
export default function Workspace() {
  const { appearance, setAppearance, resolvedTheme } = useAppearance();
  const [me, setMe] = useState<any>(),
    [setup, setSetup] = useState(false),
    [loaded, setLoaded] = useState(false),
    [bootstrapError, setBootstrapError] = useState<{ message: string; retryAfterSeconds: number | null } | null>(null),
    [autoRetryUsed, setAutoRetryUsed] = useState(false),
    [brand, setBrand] = useState<any>({ productName: "Workspace" }),
    [authMethods, setAuthMethods] = useState<any>({
      local: true,
      oidc: { enabled: false },
    }),
    [screen, setScreen] = useState("home"),
    [current, setCurrent] = useState(""),
    [roots, setRoots] = useState<any[]>([]),
    [root, setRoot] = useState(""),
    [version, setVersion] = useState(0),
    [search, setSearch] = useState(false),
    [create, setCreate] = useState<any>(),
    [toast, setToast] = useState(""),
    [sidebar, setSidebar] = useState(true);
  function showRecoverable(error: unknown) {
    const limited = error instanceof ApiError && error.status === 429;
    const retryAfterSeconds =
      error instanceof ApiError && error.retryAfterSeconds !== null &&
      Number.isFinite(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 0
        ? error.retryAfterSeconds
        : null;
    setBootstrapError({
      message: limited
        ? "The server is temporarily handling too many requests. Your session is still protected."
        : "Workspace could not finish loading. Your session has not been signed out.",
      retryAfterSeconds,
    });
  }
  async function loadResources() {
    try {
      const nodes = await api("/resources");
      setRoots(nodes);
      setRoot((v) =>
        nodes.some((n: any) => n.id === v) ? v : nodes[0]?.id || "",
      );
      setBootstrapError(null);
      setAutoRetryUsed(false);
    } catch (error) {
      // A temporary 429/5xx/network failure is not evidence of logout.
      // Preserve identity, the session token, and the previous tree.
      showRecoverable(error);
    }
  }
  async function init() {
    let m: any;
    try {
      m = await api("/me");
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        // Only an explicit authentication failure at /me selects Login.
        setMe(null);
        setCsrf("");
        setRoots([]);
        setRoot("");
        try {
          const [setupState, branding, methods] = await Promise.all([
            api("/setup"), api("/branding"), api("/auth/methods"),
          ]);
          setSetup(setupState.required);
          setBrand(branding);
          setAuthMethods(methods);
          setBootstrapError(null);
        } catch (bootstrapFailure) {
          showRecoverable(bootstrapFailure);
        }
      } else {
        showRecoverable(error);
      }
      setLoaded(true);
      return;
    }
    setMe(m);
    setBrand(m.branding);
    setAuthMethods(m.authentication || authMethods);
    setCsrf(m.csrf);
    await loadResources();
    setLoaded(true);
  }
  // Exactly one bounded automatic retry per failure episode. Honor the
  // server's Retry-After hint, and avoid background polling storms.
  useEffect(() => {
    if (!bootstrapError || autoRetryUsed) return;
    const seconds = Math.max(3, bootstrapError.retryAfterSeconds ?? 5);
    if (seconds > 120) return; // Wait for an explicit user retry.
    const timer = window.setTimeout(() => {
      setAutoRetryUsed(true);
      void init();
    }, seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [bootstrapError, autoRetryUsed]);
  useEffect(() => {
    init();
    const p = new URLSearchParams(location.search).get("page");
    if (p) {
      setCurrent(p);
      setScreen("resource");
    }
    if (innerWidth < 800) setSidebar(false);
    const open = (e: any) => {
      setCurrent(e.detail);
      setScreen("resource");
      history.replaceState(null, "", `/?page=${e.detail}`);
      if (innerWidth < 800) setSidebar(false);
    };
    const refresh = () => setVersion((v) => v + 1);
    const notice = (e: any) => {
      setToast(e.detail);
      setTimeout(() => setToast(""), 6500);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
    };
    window.addEventListener("workspace-open", open);
    window.addEventListener("workspace-changed", refresh);
    window.addEventListener("workspace-notice", notice);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("workspace-open", open);
      window.removeEventListener("workspace-changed", refresh);
      window.removeEventListener("workspace-notice", notice);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (me) void loadResources();
  }, [version]);
  useEffect(() => {
    document.title = brand.productName;
    // Preserve customer branding in both schemes. An accent tuned for a
    // light surface may be unreadable on dark surfaces unless brightened.
    const accent = brand.primaryAccent || "#177a64";
    document.documentElement.style.setProperty(
      "--accent",
      resolvedTheme === "dark"
        ? `color-mix(in srgb, ${accent} 55%, #ffffff)`
        : accent,
    );
    if (brand.favicon) {
      let el = document.querySelector(
        'link[rel="icon"]',
      ) as HTMLLinkElement | null;
      if (!el) {
        el = document.createElement("link");
        el.rel = "icon";
        document.head.append(el);
      }
      el.href = brand.favicon;
    }
  }, [brand, resolvedTheme]);
  const navigate = (s: string) => {
    setScreen(s);
    setCurrent("");
    history.replaceState(null, "", "/");
    if (innerWidth < 800) setSidebar(false);
  };
  const nav = [
    ["home", "Home", Home],
    ["recent", "Recent", Clock],
    ["favourites", "Favourites", Star],
    ["templates", "Templates", LayoutTemplate],
  ] as const;
  if (!loaded) return <Spinner />;
  const recovery = bootstrapError && (
    <div className="bootstrap-notice" role="alert">
      <strong>Workspace connection interrupted</strong>
      <p>{bootstrapError.message}</p>
      {bootstrapError.retryAfterSeconds !== null && (
        <p className="muted">
          Server requested a retry after {bootstrapError.retryAfterSeconds} seconds.
        </p>
      )}
      <button className="button primary" onClick={() => void init()}>
        Retry loading workspace
      </button>
    </div>
  );
  if (!me)
    return (
      <>
        {bootstrapError ? recovery : <Login setup={setup} brand={brand} auth={authMethods} done={init} theme={resolvedTheme} />}
        {toast && (
          <div className="toast" role="alert">
            {toast}
          </div>
        )}
      </>
    );
  return (
    <div
      className={`workspace ${sidebar ? "sidebar-visible" : "sidebar-hidden"}`}
    >
      <aside className="sidebar">
        <div className="brand">
          {(resolvedTheme === "dark" && brand.logoDark) || brand.logoLight ? (
            <img
              src={(resolvedTheme === "dark" && brand.logoDark) || brand.logoLight}
              alt=""
              className={resolvedTheme === "dark" && !brand.logoDark ? "dark-logo-fallback" : undefined}
            />
          ) : (
            <div className="brand-mark">✳</div>
          )}
          <strong>{brand.productName}</strong>
          <button
            className="icon-button sidebar-close"
            aria-label="Close sidebar"
            onClick={() => setSidebar(false)}
          >
            <PanelLeft size={17} />
          </button>
        </div>
        <div className="workspace-select">
          <span className="workspace-symbol">
            {(roots.find((n) => n.id === root)?.title || "W")[0]}
          </span>
          <select
            aria-label="Current workspace"
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              navigate("home");
            }}
          >
            {roots.map((n) => (
              <option value={n.id} key={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>
        <button className="search-trigger" onClick={() => setSearch(true)}>
          <Search size={16} />
          <span>Search anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav>
          {nav.map(([key, label, Icon]) => (
            <button
              className={screen === key ? "active" : ""}
              key={key}
              onClick={() => navigate(key)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <div className="nav-heading">
          <span>YOUR SPACES</span>
          <button
            className="icon-button"
            aria-label="New space"
            onClick={() => setCreate({ parent: root, kind: "space" })}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="tree-scroll">
          {root && (
            <Tree
              parent={root}
              current={current}
              version={version}
              create={setCreate}
            />
          )}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => navigate("trash")}>
            <Trash2 size={17} />
            Trash
          </button>
          <button
            className={screen === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
          >
            <SettingsIcon size={17} />
            Settings & members
          </button>
          <div className="profile">
            <span className="avatar">{me.user.name[0]}</span>
            <div>
              <strong>{me.user.name}</strong>
              <small>{me.organisation.name}</small>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() =>
                run(async () => {
                  await api("/auth/logout", "POST", {});
                  await init();
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="icon-button"
            aria-label="Toggle sidebar"
            onClick={() => setSidebar((v) => !v)}
          >
            <PanelLeft size={18} />
          </button>
          <div className="crumb">
            {roots.find((n) => n.id === root)?.title || "Workspace"}
            <span>/</span>
            <span>
              {screen === "resource"
                ? "Workspace"
                : screen[0].toUpperCase() + screen.slice(1)}
            </span>
          </div>
          <div className="topbar-right">
            <span className="private-label">Your team’s shared space</span>
            <button
              type="button"
              className="icon-button"
              aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={() => setAppearance(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="button primary small-button"
              onClick={() => setCreate({ parent: root, kind: "page" })}
            >
              <Plus size={16} />
              New page
            </button>
          </div>
        </header>
        <div className="main-scroll">
          {recovery}
          {bootstrapError && !roots.length ? null : screen === "resource" && current ? (
            <Resource
              key={current}
              id={current}
              me={me}
              onGone={() => navigate("trash")}
              create={setCreate}
              theme={resolvedTheme}
            />
          ) : screen === "settings" ? (
            <Settings me={me} reload={init} appearance={appearance} setAppearance={setAppearance} />
          ) : (
            <Dashboard
              screen={screen}
              me={me}
              root={root}
              version={version}
              create={setCreate}
            />
          )}
        </div>
      </main>
      {search && <SearchDialog close={() => setSearch(false)} />}{" "}
      {create && (
        <CreateDialog
          {...create}
          root={root}
          close={() => setCreate(undefined)}
        />
      )}{" "}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast("")}>
          {toast}
        </div>
      )}
    </div>
  );
}
function Tree({
  parent,
  current,
  version,
  create,
  depth = 0,
}: {
  parent: string;
  current: string;
  version: number;
  create: (v: any) => void;
  depth?: number;
}) {
  const [nodes, setNodes] = useState<any[]>([]),
    [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    api(`/resources?parent_id=${parent}`)
      .then(setNodes)
      .catch((e) => notify(e.message));
  }, [parent, version]);
  return (
    <>
      {nodes
        .filter((n) => n.kind !== "record")
        .map((n) => (
          <div key={n.id}>
            <div
              className={`tree-item ${current === n.id ? "selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <button
                className="tree-expand"
                aria-label={`Expand ${n.title}`}
                onClick={() => setOpen((v) => ({ ...v, [n.id]: !v[n.id] }))}
              >
                {open[n.id] ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
              <button className="tree-title" onClick={() => go(n.id)}>
                <span>{icon(n)}</span>
                {n.title}
              </button>
              {n.kind !== "database" && n.effective_permission >= 3 && (
                <button
                  className="tree-add"
                  aria-label={`Add to ${n.title}`}
                  onClick={() =>
                    create({
                      parent: n.id,
                      kind: n.kind === "workspace" ? "space" : "page",
                    })
                  }
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
            {open[n.id] && (
              <Tree
                parent={n.id}
                current={current}
                version={version}
                create={create}
                depth={depth + 1}
              />
            )}
          </div>
        ))}
    </>
  );
}
function Dashboard({
  screen,
  me,
  root,
  version,
  create,
}: {
  screen: string;
  me: any;
  root: string;
  version: number;
  create: (v: any) => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [spaces, setSpaces] = useState<any[]>([]),
    [notes, setNotes] = useState<any[]>([]);
  useEffect(() => {
    run(async () => {
      setItems(
        await api(
          screen === "trash"
            ? "/trash"
            : `/resources?${screen === "favourites" ? "favourites" : "recent"}=true&limit=100`,
        ),
      );
      if (root) setSpaces(await api(`/resources?parent_id=${root}`));
      if (screen === "home") setNotes(await api("/notifications"));
    });
  }, [screen, root, version]);
  const templates = [
    ["blank", "Blank page", "A little space for your next idea.", "✧"],
    [
      "meeting",
      "Meeting notes",
      "Turn conversations into clear next steps.",
      "☷",
    ],
    ["project", "Project plan", "Keep milestones and decisions together.", "◈"],
    ["tasks", "Task tracker", "A table and board to keep work moving.", "☑"],
    [
      "knowledge",
      "Knowledge base",
      "Build a useful home for shared knowledge.",
      "📖",
    ],
    ["sop", "Standard procedure", "Document a repeatable way of working.", "↳"],
    ["decision", "Decision log", "Remember the why behind the what.", "◎"],
  ];
  return (
    <div className="dashboard">
      <div className="eyebrow">
        {screen === "home" ? "YOUR WORK, TOGETHER" : "WORKSPACE"}
      </div>
      <h1>
        {screen === "home"
          ? `Welcome back, ${me.user.name.split(" ")[0]}.`
          : screen === "favourites"
            ? "Your favourites"
            : screen === "templates"
              ? "Start with a little structure."
              : screen === "trash"
                ? "Trash"
                : "Recently viewed"}
      </h1>
      <p className="lead">
        {screen === "home"
          ? "A home for your team’s knowledge, projects and next big ideas."
          : screen === "templates"
            ? "Useful starting points. Make them your own."
            : screen === "trash"
              ? "Restore a parent before restoring its nested pages."
              : "Pick up where you left off."}
      </p>
      {screen === "home" && (
        <div className="hero">
          <div>
            <span className="eyebrow">ROOM TO THINK. SPACE TO BUILD.</span>
            <h2>Bring your next idea to life.</h2>
            <p>Start a page, connect the details, and move work forward.</p>
            <button
              className="button primary"
              onClick={() =>
                create({ parent: spaces[0]?.id || root, kind: "page" })
              }
            >
              <Plus size={16} />
              Create a page
            </button>
            <button
              className="text-button"
              onClick={() =>
                create({
                  parent: spaces[0]?.id || root,
                  kind: "page",
                  importing: true,
                })
              }
            >
              Import your work <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-sheet">
              <span>◈</span>
              <i />
              <i />
              <i />
              <div>✓ &nbsp; A clear next step</div>
            </div>
            <div className="art-dot">✳</div>
          </div>
        </div>
      )}
      {screen === "templates" ? (
        <div className="template-grid">
          {templates.map(([t, name, desc, symbol]) => (
            <button
              className="template-card"
              key={t}
              onClick={() =>
                create({
                  parent: spaces[0]?.id || root,
                  kind: t === "tasks" ? "database" : "page",
                  template: t,
                  title: name,
                })
              }
            >
              <span className="template-icon">{symbol}</span>
              <h3>{name}</h3>
              <p>{desc}</p>
              <span className="template-use">
                Use template <ArrowRight size={15} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="section-title">
            <h2>
              {screen === "home"
                ? "Pick up where you left off"
                : screen === "trash"
                  ? "Deleted pages"
                  : "Pages & databases"}
            </h2>
            <span>{items.length} items</span>
          </div>
          {items.length ? (
            <div className={screen === "home" ? "recent-grid" : "page-list"}>
              {items.slice(0, screen === "home" ? 6 : 100).map((n) => (
                <div className="page-card" key={n.id}>
                  <button
                    onClick={() => screen !== "trash" && go(n.id)}
                    className="page-card-open"
                  >
                    <span className="page-icon">{icon(n)}</span>
                    <strong>{n.title}</strong>
                    <span className="muted">
                      {n.kind === "database" ? "Database" : "Page"} ·{" "}
                      {date((screen === "recent" || screen === "home") ? (n.viewed_at || n.updated_at) : n.updated_at)}
                    </span>
                  </button>
                  {screen === "trash" && (
                    <button
                      className="button"
                      onClick={() =>
                        run(async () => {
                          await api(`/resources/${n.id}/restore`, "POST", {});
                          changed();
                        })
                      }
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title={
                screen === "favourites"
                  ? "Keep the important pages close."
                  : screen === "recent" || screen === "home"
                    ? "No recently viewed pages yet."
                    : "A fresh start."
              }
            >
              <p>
                {screen === "favourites"
                  ? "Star any page to find it here."
                  : "Open a page to see it here when you return."}
              </p>
            </Empty>
          )}
          {screen === "home" && (
            <>
              <div className="section-title">
                <h2>Your spaces</h2>
                <button className="text-button" onClick={() => go(root)}>
                  Manage workspace <ArrowUpRight size={14} />
                </button>
              </div>
              <div className="space-grid">
                {spaces.map((n) => (
                  <button
                    className="space-card"
                    key={n.id}
                    onClick={() => go(n.id)}
                  >
                    <span>{icon(n)}</span>
                    <div>
                      <strong>{n.title}</strong>
                      <small>A shared home for your team</small>
                    </div>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </div>
              {notes.length > 0 && (
                <>
                  <div className="section-title">
                    <h2>For your attention</h2>
                  </div>
                  {notes.slice(0, 5).map((n) => (
                    <button
                      className="notification"
                      key={n.id}
                      onClick={() => go(n.resource_id)}
                    >
                      {n.message}
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
function SearchDialog({ close }: { close: () => void }) {
  const [q, setQ] = useState(""),
    [items, setItems] = useState<any[]>([]),
    [active, setActive] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    const t = setTimeout(
      () =>
        run(async () => {
          const v = await api("/search?q=" + encodeURIComponent(q));
          if (!c.signal.aborted) {
            setItems(v);
            setActive(0);
          }
        }),
      200,
    );
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [q]);
  const openResult = (item: any) => {
    go(item.resource_id || item.id);
    close();
  };
  return (
    <Modal title="Search your workspace" close={close}>
      <div className="search-field">
        <Search size={20} aria-hidden="true" />
        <input
          autoFocus
          data-initial-focus
          role="combobox"
          aria-label="Search workspace"
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls="workspace-search-options"
          aria-activedescendant={
            items[active] ? "workspace-search-option-" + active : undefined
          }
          aria-describedby="workspace-search-help"
          placeholder="Find pages, projects, or files…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setItems([]);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && items.length) {
              e.preventDefault();
              setActive((v) => (v + 1) % items.length);
            } else if (e.key === "ArrowUp" && items.length) {
              e.preventDefault();
              setActive((v) => (v - 1 + items.length) % items.length);
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              openResult(items[active]);
            }
          }}
        />
      </div>
      <div
        className="search-results"
        role="listbox"
        id="workspace-search-options"
        aria-label="Accessible workspace search results"
      >
        {items.map((n, index) => (
          <button
            role="option"
            id={"workspace-search-option-" + index}
            aria-selected={index === active}
            key={n.id}
            onMouseEnter={() => setActive(index)}
            onClick={() => openResult(n)}
          >
            <span className="page-icon">{icon(n)}</span>
            <div>
              <strong>{n.title}</strong>
              <p>{n.snippet || n.kind}</p>
            </div>
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        ))}
        {q && !items.length && <Empty title="No matching pages" />}
      </div>
      <div className="modal-foot muted" id="workspace-search-help">
        Use <kbd>↑</kbd> <kbd>↓</kbd> to select and <kbd>Enter</kbd> to open. Search
        only includes content you can access. <kbd>Esc</kbd> closes.
      </div>
    </Modal>
  );
}
function CreateDialog({
  parent,
  kind,
  root,
  close,
  template = "",
  title: initial = "",
  importing = false,
}: {
  parent: string;
  kind: string;
  root: string;
  close: () => void;
  template?: string;
  title?: string;
  importing?: boolean;
}) {
  const [name, setName] = useState(initial),
    [type, setType] = useState(kind),
    [destination, setDestination] = useState(parent),
    [parents, setParents] = useState<any[]>([]),
    [file, setFile] = useState<File>(),
    [preview, setPreview] = useState<any>(),
    [mapping, setMapping] = useState<any[]>([]),
    [previewContent, setPreviewContent] = useState(""),
    [databaseChoices, setDatabaseChoices] = useState<any[]>([]),
    [targetDatabase, setTargetDatabase] = useState(""),
    [appendConfirmed, setAppendConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    run(async () => {
      const spaces = await api(`/resources?parent_id=${root}&limit=200`);
      setParents([
        { id: root, title: "Workspace root", kind: "workspace" },
        ...spaces,
      ]);
      if (parent === root && kind !== "space")
        setDestination(spaces.find((n: any) => n.kind === "space")?.id || root);
    });
  }, []);
  useEffect(() => {
    if (!importing) return;
    run(async () => {
      const siblings = await api(
        `/resources?parent_id=${destination}&limit=200`);
      setDatabaseChoices(siblings.filter((r: any) =>
        r.kind === "database" && !r.deleted_at));
    });
  }, [destination, importing]);
  async function previewFile() {
    if (!file || !file.name.toLowerCase().endsWith(".csv"))
      return notify("Choose a CSV file to preview its column mapping");
    setBusy(true);
    try {
      await run(async () => {
        if (file.size > 2097152)
          throw Error("CSV exceeds the 2 MiB import limit");
        const content = await file.text();
        const proposal = await api("/imports/preview", "POST", {
          parent_id: destination, content,
          ...(targetDatabase ? { target_database_id: targetDatabase } : {}),
        });
        setPreviewContent(content);
        setPreview(proposal);
        setMapping(proposal.mapping);
      });
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(async () => {
      if (importing) {
        if (!file) throw Error("Choose a Markdown or CSV file");
        const isCsv = file.name.toLowerCase().endsWith(".csv");
        if (isCsv && !preview)
          throw Error("Preview the CSV and review its column mapping before import");
        if (isCsv && targetDatabase && (!appendConfirmed || !preview.target ||
          preview.target.id !== targetDatabase))
          throw Error("Confirm the append-only target import after preview");
        const content = isCsv ? previewContent : await file.text();
        const j = await api("/imports", "POST", {
          parent_id: destination,
          name: name || file.name,
          format: isCsv ? "csv" : "markdown",
          content,
          ...(isCsv ? { mapping } : {}),
          ...(isCsv && targetDatabase ? {
            target_database_id: targetDatabase,
            expected_schema_digest: preview.target.schema_digest,
            existing_mode: "append",
          } : {}),
        });
        notify(
          "Import queued. This window will open the result when it is ready.",
        );
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const job = await api(`/jobs/${j.id}`);
          if (job.status === "failed") throw Error(job.result.error);
          if (job.status === "completed") {
            changed();
            go(job.result.resource_id);
            close();
            return;
          }
        }
        throw Error(`Import still running. Job ID: ${j.id}`);
      }
      const n = await api("/resources", "POST", {
        kind: type,
        parent_id: destination,
        title: name || "Untitled",
        template,
      });
      changed();
      go(n.id);
      close();
    });
    setBusy(false);
  }
  return (
    <Modal
      title={importing ? "Import your work" : "Create something new"}
      close={close}
    >
      <form onSubmit={submit} className="form">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Give it a clear, useful title"
            maxLength={500}
          />
        </Field>
        {!importing && (
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                if (e.target.value === "space") setDestination(root);
                else if (destination === root)
                  setDestination(
                    parents.find((n) => n.kind === "space")?.id || root,
                  );
              }}
            >
              <option value="page">Page</option>
              <option value="database">Database</option>
              <option value="space">Space</option>
            </select>
          </Field>
        )}
        <Field label="Create in">
          <select
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setPreview(undefined);
              setMapping([]);
              setPreviewContent("");
              setTargetDatabase("");
              setAppendConfirmed(false);
            }}
          >
            {!parents.some((n) => n.id === parent) && (
              <option value={parent}>Current page</option>
            )}
            {parents
              .filter((n) =>
                type === "space"
                  ? n.kind === "workspace"
                  : n.kind === "space" || n.kind === "page",
              )
              .map((n) => (
                <option value={n.id} key={n.id}>
                  {n.title}
                </option>
              ))}
          </select>
        </Field>
        {importing && (
          <>
            <Field label="Markdown or CSV file">
              <input
                type="file"
                accept=".md,.markdown,.csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0]);
                  setPreview(undefined);
                  setMapping([]);
                  setPreviewContent("");
                  setAppendConfirmed(false);
                }}
              />
            </Field>
            {file?.name.toLowerCase().endsWith(".csv") && (
              <>
                <Field label="Import destination mode">
                  <select
                    aria-label="Import destination mode"
                    value={targetDatabase}
                    onChange={(e) => {
                      setTargetDatabase(e.target.value);
                      setPreview(undefined);
                      setMapping([]);
                      setPreviewContent("");
                      setAppendConfirmed(false);
                    }}
                  >
                    <option value="">Create a new database</option>
                    {databaseChoices.map((db: any) => (
                      <option key={db.id} value={db.id}>
                        Append records to {db.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="button" className="button" disabled={busy}
                  onClick={() => void previewFile()}>
                  Preview CSV columns
                </button>
                {preview && (
                  <div className="import-preview">
                    <strong>{preview.row_count} data rows · {preview.columns.length} columns</strong>
                    <p>Review the suggested types. Untick fields you do not want to import. Every row is checked again before saving.</p>
                    <div style={{ maxHeight: 340, overflow: "auto" }}>
                      {mapping.map((item: any, index: number) => (
                        <div key={item.source} className="import-column">
                          <label>
                            <input type="checkbox" checked={!item.skip}
                              aria-label={`Import column ${item.source}`}
                              onChange={(e) => setMapping((old) => old.map(
                                (v: any, i: number) => i === index ?
                                  { ...v, skip: !e.target.checked } : v))} />
                            <strong>{item.source}</strong>
                          </label>
                          <small>{preview.sample.slice(0, 2).map(
                            (r: string[]) => r[index]).join(" · ").slice(0, 120)}</small>
                          {targetDatabase && preview.target && (
                            <label>
                              Existing database property
                              <select
                                aria-label={`Target property for ${item.source}`}
                                disabled={item.skip}
                                value={preview.target.properties.some(
                                  (p: any) => p.id === item.id) ?
                                  item.id : ""}
                                onChange={(e) => {
                                  const property = preview.target.properties.find(
                                    (p: any) => p.id === e.target.value);
                                  if (!property) return;
                                  setMapping((old) => old.map(
                                    (v: any, i: number) => i === index ?
                                      { ...v, id: property.id,
                                        name: property.name,
                                        type: property.type } : v));
                                }}
                              >
                                <option value="">Select a property</option>
                                {preview.target.properties.map((p: any) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.type})
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label>
                            Field type
                            <select aria-label={`Type for ${item.source}`}
                              value={item.type}
                              disabled={item.skip || !!targetDatabase}
                              onChange={(e) => setMapping((old) => old.map(
                                (v: any, i: number) => i === index ?
                                  { ...v, type: e.target.value } : v))}>
                              {["title", "text", "number", "date", "checkbox"]
                                .map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                            </select>
                          </label>
                          <label>
                            Column name
                            <input aria-label={`Column name for ${item.source}`}
                              maxLength={120} disabled={item.skip}
                              value={item.name}
                              onChange={(e) => setMapping((old) => old.map(
                                (v: any, i: number) => i === index ?
                                  { ...v, name: e.target.value } : v))} />
                          </label>
                        </div>
                      ))}
                    </div>
                    <small>{preview.warnings[0]}</small>
                    {targetDatabase && (
                      <label className="import-append-confirmation">
                        <input type="checkbox"
                          aria-label="Confirm append-only import"
                          checked={appendConfirmed}
                          onChange={(e) => setAppendConfirmed(e.target.checked)} />
                        Append new records to this database without updating,
                        replacing or deduplicating existing records.
                      </label>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || (importing &&
            !!file?.name.toLowerCase().endsWith(".csv") &&
            (!preview || !!targetDatabase && !appendConfirmed))}
            className="button primary">
            {busy ? "Working…" : importing ? "Import" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Login({
  setup,
  brand,
  auth,
  done,
  theme,
}: {
  setup: boolean;
  brand: any;
  auth: any;
  done: () => Promise<void>;
  theme: "light" | "dark";
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [invite, setInvite] = useState("");
  useEffect(() => {
    const value = new URLSearchParams(location.search).get("invite") || "";
    if (value) {
      setInvite(value);
      history.replaceState(null, "", "/");
    }
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (setup) {
        const r = await fetch("/api/v1/setup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Setup-Token": String(v.setupToken),
          },
          body: JSON.stringify({
            organisation: v.organisation,
            workspace: v.workspace,
            name: v.name,
            email: v.email,
            password: v.password,
            demo: v.demo === "on",
          }),
        });
        const result = await r.json();
        if (!r.ok) throw Error(result.error);
      } else
        await api(
          invite ? "/auth/accept-invite" : "/auth/login",
          "POST",
          invite
            ? { token: invite, password: v.password }
            : { email: v.email, password: v.password },
        );
      history.replaceState(null, "", "/");
      await done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="login-page"
      style={
        brand.loginBackground
          ? { backgroundImage: `url(${brand.loginBackground})` }
          : undefined
      }
    >
      <section className="login-card">
        <div className="brand">
          {(theme === "dark" && brand.logoDark) || brand.logoLight ? (
            <img
              src={(theme === "dark" && brand.logoDark) || brand.logoLight}
              alt=""
              className={theme === "dark" && !brand.logoDark ? "dark-logo-fallback" : undefined}
            />
          ) : (
            <div className="brand-mark">✳</div>
          )}
          <strong>{brand.productName}</strong>
        </div>
        <div className="eyebrow">A SHARED PLACE FOR GOOD WORK</div>
        <h1>
          {setup
            ? "Make yourself at home."
            : invite
              ? "Join your team."
              : "Welcome back."}
        </h1>
        <p className="muted">
          {setup
            ? "Set up your organisation and first workspace."
            : invite
              ? "Use your existing account password, or choose a password for your new account."
              : "Sign in to your team’s workspace."}
        </p>
        {!setup && auth.oidc?.enabled && (
          <a
            className="button primary full"
            href={`/api/v1/auth/oidc/start?${new URLSearchParams({
              return_to: "/",
              ...(invite ? { invite } : {}),
            }).toString()}`}
          >
            Continue with {auth.oidc.label || "Single sign-on"}
            <ArrowRight size={16} />
          </a>
        )}
        {!setup && auth.oidc?.enabled && auth.local && (
          <div className="muted small-text">or use your local account</div>
        )}
        {(setup || auth.local) && (
        <form onSubmit={submit} className="form">
          {setup && (
            <>
              <Field label="Setup token">
                <input name="setupToken" type="password" required />
              </Field>
              <div className="form-grid">
                <Field label="Organisation">
                  <input name="organisation" required placeholder="Acme" />
                </Field>
                <Field label="Workspace">
                  <input
                    name="workspace"
                    required
                    placeholder="Team workspace"
                  />
                </Field>
              </div>
              <Field label="Your name">
                <input name="name" required autoComplete="name" />
              </Field>
            </>
          )}
          {!invite && (
            <Field label="Email">
              <input name="email" type="email" required autoComplete="email" />
            </Field>
          )}
          <Field label="Password">
            <input
              name="password"
              type="password"
              required
              minLength={setup || invite ? 12 : undefined}
              autoComplete={
                setup || invite ? "new-password" : "current-password"
              }
            />
          </Field>
          {setup && (
            <label className="checkbox-line">
              <input name="demo" type="checkbox" defaultChecked /> Include
              starter wiki, projects, and tasks
            </label>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy
              ? "Opening your workspace…"
              : setup
                ? "Create workspace"
                : invite
                  ? "Accept invitation"
                  : "Sign in"}
            <ArrowRight size={16} />
          </button>
        </form>
        )}
        {!setup && !auth.local && !auth.oidc?.enabled && (
          <p role="alert" className="error">
            No sign-in method is configured for this deployment.
          </p>
        )}
        <footer>
          {brand.supportUrl && (
            <a href={brand.supportUrl}>{brand.supportName}</a>
          )}
          {brand.privacyUrl && <a href={brand.privacyUrl}>Privacy</a>}
          {brand.termsUrl && <a href={brand.termsUrl}>Terms</a>}
          <small>{brand.legalName}</small>
        </footer>
      </section>
      <p className="login-caption">Think clearly. Build together.</p>
    </div>
  );
}
