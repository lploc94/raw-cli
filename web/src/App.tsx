import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Command,
  Folder,
  Library,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import type { DashboardBootstrap } from "../../src/dashboard/contract.js";
import type { Page, SessionSummary } from "../../src/sessions/store.js";
import { api, errorText } from "./api.js";
import { Chat } from "./chat.js";
import { isTerminal } from "./session.js";
import { usePreferences } from "./preferences.js";
import { Link, useRouter } from "./router.js";
import { Empty, ErrorMessage, Field, Modal } from "./ui.js";
import { PreferencesPage } from "./pages/Preferences.js";
import { AgentsPage } from "./pages/Agents.js";
import { ComponentsPage } from "./pages/Components.js";
import { DefinitionsPage } from "./pages/Definitions.js";
import { SettingsPage, SettingsSearch } from "./pages/Settings.js";

interface ActivityView {
  operations: Array<{
    id: string;
    sessionId: string;
    state: string;
    kind: string;
    controllable: boolean;
  }>;
  approvals: Array<{ id: string; sessionId: string; name: string }>;
}
const categories = [
  "general",
  "models",
  "appearance",
  "chat",
  "sessions",
  "diagnostics",
];
export function App() {
  const { path, navigate } = useRouter();
  const [preferences, setPreferences] = usePreferences();
  const [bootstrap, setBootstrap] = useState<DashboardBootstrap>();
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [agent, setAgent] = useState("");
  const [sessions, setSessions] = useState<Page<SessionSummary>>({ items: [] });
  const [filter, setFilter] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [command, setCommand] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityView>({
    operations: [],
    approvals: [],
  });
  const drafts = useRef(new Map<string, string>());
  const previousActivity = useRef("");
  const page = path.split("/")[1] || "chat";
  const sessionId = page === "chat" ? path.split("/")[2] : undefined;
  const refreshBootstrap = useCallback(async () => {
    try {
      const next = await api<DashboardBootstrap>("/bootstrap");
      setBootstrap(next);
      setWorkspace((old) => old || next.cwd);
      setAgent((old) =>
        next.config.agents.includes(old)
          ? old
          : (next.preferredAgent ??
            next.config.defaultAgent ??
            next.config.agents[0] ??
            ""),
      );
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);
  const refreshSessions = useCallback(async () => {
    if (!workspace || !bootstrap?.store.available) return;
    try {
      setSessions(
        await api<Page<SessionSummary>>(
          `/sessions?cwd=${encodeURIComponent(workspace)}&title=${encodeURIComponent(filter)}&limit=50`,
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [workspace, filter, bootstrap?.store.available]);
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);
  useEffect(() => {
    if (!bootstrap?.store.available) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (timer) clearTimeout(timer);
      if (document.hidden || controller.signal.aborted) return;
      try {
        const value = await api<ActivityView>(
          "/activity",
          "GET",
          undefined,
          controller.signal,
        );
        setActivity(value);
        const revision = JSON.stringify(
          value.operations.map((item) => [item.id, item.state]),
        );
        if (revision !== previousActivity.current) {
          previousActivity.current = revision;
          void refreshSessions();
        }
      } catch {
        /* Session/management requests provide their contextual connection errors. */
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    };
    const wake = () => {
      void poll();
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [bootstrap?.store.available, refreshSessions]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((old) => !old);
        setCommand("");
      }
      if (event.key === ",") {
        event.preventDefault();
        navigate("/settings/general");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [navigate]);
  useEffect(() => {
    setDrawer(false);
    setPalette(false);
  }, [path]);
  const create = async (selectedAgent = agent) => {
    try {
      const session = await api<SessionSummary>("/sessions", "POST", {
        cwd: workspace,
        agent: selectedAgent,
      });
      setError("");
      await refreshSessions();
      navigate(`/chat/${session.id}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const running = activity.operations.filter((op) => !isTerminal(op.state));
  const sidebar = (
    <div className="context-panel-inner">
      <button
        className="workspace-button"
        onClick={() => {
          setWorkspaceDraft(workspace);
          setWorkspaceError("");
          setWorkspaceDialog(true);
        }}
        title={workspace}
      >
        <Folder size={17} aria-hidden="true" />
        <span>
          <strong>Workspace</strong>
          <small>
            {workspace.split("/").filter(Boolean).at(-1) ?? workspace}
          </small>
        </span>
        <Chevron />
      </button>
      {page === "chat" ? (
        <>
          <Field label="New chat agent">
            <select
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
            >
              {bootstrap?.config.agents.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <button
            className="primary new-chat"
            onClick={() => {
              void create();
            }}
            disabled={
              !bootstrap?.config.valid || !agent || !bootstrap.store.available
            }
          >
            <Plus size={17} aria-hidden="true" />
            New chat
          </button>
          <label className="search-input">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Search session titles"
              placeholder="Search titles…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="session-list">
            {sessions.items.length ? (
              sessions.items.map((session, index) => {
                const today =
                  new Date(session.updatedAt).toDateString() ===
                  new Date().toDateString();
                const previousToday =
                  index > 0 &&
                  new Date(
                    sessions.items[index - 1]!.updatedAt,
                  ).toDateString() === new Date().toDateString();
                const active = running.some(
                  (op) => op.sessionId === session.id,
                );
                const approval = activity.approvals.some(
                  (item) => item.sessionId === session.id,
                );
                return (
                  <div key={session.id}>
                    {(index === 0 || today !== previousToday) && (
                      <div className="group-label">
                        {today ? "Today" : "Earlier"}
                      </div>
                    )}
                    <Link
                      className={`session-row ${session.id === sessionId ? "selected" : ""}`}
                      href={`/chat/${session.id}`}
                      aria-current={
                        session.id === sessionId ? "page" : undefined
                      }
                    >
                      <span
                        className={`session-dot ${approval ? "waiting" : active ? "running" : ""}`}
                        aria-hidden="true"
                      />
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          {approval
                            ? "Needs approval"
                            : active
                              ? "Running"
                              : (session.agentName ?? "Saved session")}
                        </small>
                      </span>
                    </Link>
                  </div>
                );
              })
            ) : (
              <p className="muted small">
                {filter
                  ? "No matching titles."
                  : "Your saved sessions appear here."}
              </p>
            )}
            {filter && (
              <button className="text-button" onClick={() => setFilter("")}>
                Clear filters
              </button>
            )}
            {sessions.nextCursor && (
              <button
                onClick={() => {
                  void api<Page<SessionSummary>>(
                    `/sessions?cwd=${encodeURIComponent(workspace)}&title=${encodeURIComponent(filter)}&limit=50&before=${encodeURIComponent(sessions.nextCursor!)}`,
                  ).then(
                    (next) =>
                      setSessions((old) => ({
                        ...next,
                        items: [...old.items, ...next.items],
                      })),
                    (cause) => setError(errorText(cause)),
                  );
                }}
              >
                More sessions
              </button>
            )}
          </div>
        </>
      ) : page === "settings" ? (
        <nav aria-label="Settings categories" className="context-nav">
          <SettingsSearch />
          <div className="group-label">Settings</div>
          {categories.map((name) => (
            <Link
              key={name}
              href={`/settings/${name}`}
              aria-current={path.endsWith(`/${name}`) ? "page" : undefined}
            >
              {name === "models"
                ? "Models & connections"
                : name === "chat"
                  ? "Chat"
                  : name[0]!.toUpperCase() + name.slice(1)}
            </Link>
          ))}
        </nav>
      ) : page === "library" ? (
        <nav aria-label="Library categories" className="context-nav">
          <div className="group-label">Library</div>
          {["tools", "skills", "vars", "mcp", "packages"].map((name) => (
            <Link key={name} href={`/library/${name}`}>
              {name === "mcp" ? "MCP" : name[0]!.toUpperCase() + name.slice(1)}
            </Link>
          ))}
        </nav>
      ) : (
        <nav aria-label="Agents" className="context-nav">
          <div className="group-label">Agents</div>
          {bootstrap?.config.agents.map((name) => (
            <Link key={name} href={`/agents/${encodeURIComponent(name)}`}>
              {name}
            </Link>
          ))}
        </nav>
      )}
      <div className="context-footer">
        <span className="local-indicator">● Local workspace</span>
        <small>Raw {bootstrap?.version ?? ""}</small>
      </div>
    </div>
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="app-shell">
        <nav className="rail" aria-label="Main">
          <Link href="/chat" className="brand" aria-label="Raw home">
            r.
          </Link>
          {(
            [
              { id: "chat", label: "Chat", Icon: MessageSquare },
              { id: "agents", label: "Agents", Icon: Bot },
              { id: "library", label: "Library", Icon: Library },
            ] as const
          ).map(({ id, label, Icon }) => (
            <Link
              key={id}
              href={`/${id}`}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
          <Link
            href="/settings/general"
            className={`settings-link ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings size={21} aria-hidden="true" />
            <span>Settings</span>
          </Link>
        </nav>
        <aside className="context-panel" aria-label="Workspace navigation">
          {sidebar}
        </aside>
        <div
          className="resize-handle"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Context panel width"
          aria-valuemin={240}
          aria-valuemax={320}
          aria-valuenow={preferences.contextWidth}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
              event.preventDefault();
              setPreferences((old) => ({
                ...old,
                contextWidth:
                  event.key === "Home"
                    ? 260
                    : Math.max(
                        240,
                        Math.min(
                          320,
                          old.contextWidth +
                            (event.key === "ArrowRight" ? 10 : -10),
                        ),
                      ),
              }));
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setPreferences((old) => ({
                ...old,
                contextWidth: Math.max(240, Math.min(320, event.clientX - 72)),
              }));
          }}
          onDoubleClick={() =>
            setPreferences((old) => ({ ...old, contextWidth: 260 }))
          }
        />
        <div className="main-column">
          <div className="app-toolbar">
            <button
              className="icon-button mobile-nav"
              aria-label="Workspace menu"
              onClick={() => setDrawer(true)}
            >
              <Menu size={19} aria-hidden="true" />
            </button>
            <span className="breadcrumb">
              Workspace<span>/</span>
              {page[0]!.toUpperCase() + page.slice(1)}
            </span>
            <div className="toolbar-actions">
              <button
                className="search-command"
                aria-label="Quick navigation"
                onClick={() => {
                  setCommand("");
                  setPalette(true);
                }}
              >
                <Search size={15} aria-hidden="true" />
                <span>Search</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className={`activity-button ${activity.approvals.length ? "attention" : ""}`}
                aria-label={`Activity${activity.approvals.length ? ` · ${activity.approvals.length} approvals` : ""}`}
                onClick={() => setActivityOpen(true)}
              >
                <Activity size={18} aria-hidden="true" />
                <span>Activity</span>
                {running.length > 0 && (
                  <span className="count">{running.length}</span>
                )}
              </button>
            </div>
          </div>
          <main id="main" tabIndex={-1}>
            <ErrorMessage>{error}</ErrorMessage>
            {!bootstrap ? (
              <Empty
                title={
                  error ? "Connection unavailable" : "Opening your workspace…"
                }
              >
                {error
                  ? "Reopen the launch link from your terminal to connect."
                  : "Reading local configuration."}
              </Empty>
            ) : page === "chat" ? (
              sessionId ? (
                <Chat
                  key={sessionId}
                  id={sessionId}
                  bootstrap={bootstrap}
                  preferences={preferences}
                  drafts={drafts.current}
                  onChanged={() => {
                    void refreshSessions();
                  }}
                  resizeInspector={(width) =>
                    setPreferences((old) => ({ ...old, inspectorWidth: width }))
                  }
                />
              ) : (
                <Empty
                  title="Start a conversation"
                  action={
                    <button
                      className="primary"
                      disabled={
                        !bootstrap.config.valid ||
                        !agent ||
                        !bootstrap.store.available
                      }
                      onClick={() => {
                        void create();
                      }}
                    >
                      <Plus size={18} aria-hidden="true" />
                      New chat
                    </button>
                  }
                >
                  {!bootstrap.config.valid
                    ? "Open Settings to initialize or repair your config."
                    : !bootstrap.store.available
                      ? bootstrap.store.diagnostic
                      : `Choose an agent and work on a task in ${workspace}.`}
                </Empty>
              )
            ) : page === "settings" &&
              (path.endsWith("/appearance") || path.endsWith("/chat")) ? (
              <PreferencesPage
                kind={path.endsWith("/chat") ? "chat" : "appearance"}
                value={preferences}
                setValue={setPreferences}
              />
            ) : page === "agents" ? (
              <AgentsPage changed={refreshBootstrap} createChat={create} />
            ) : page === "settings" ? (
              <SettingsPage
                key={path}
                changed={refreshBootstrap}
                createChat={create}
              />
            ) : page === "library" &&
              ["tools", "skills"].includes(path.split("/")[2] ?? "tools") ? (
              <ComponentsPage
                key={path}
                kind={path.split("/")[2] === "skills" ? "skills" : "tools"}
                changed={refreshBootstrap}
              />
            ) : page === "library" &&
              ["vars", "mcp"].includes(path.split("/")[2] ?? "") ? (
              <DefinitionsPage
                key={path}
                kind={path.split("/")[2] === "mcp" ? "mcp" : "vars"}
                changed={refreshBootstrap}
              />
            ) : (
              <div className="management-page">
                <h1>Packages</h1>
                <p>Portable package management.</p>
              </div>
            )}
          </main>
        </div>
      </div>
      <Modal
        open={drawer}
        onOpenChange={setDrawer}
        title="Workspace navigation"
        className="drawer"
      >
        {sidebar}
      </Modal>
      <Modal
        open={workspaceDialog}
        onOpenChange={setWorkspaceDialog}
        title="Choose workspace"
        description="The directory must already exist. Existing sessions keep their saved workspace."
      >
        <ErrorMessage>{workspaceError}</ErrorMessage>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void api<{ cwd: string }>("/workspaces/validate", "POST", {
              cwd: workspaceDraft,
            }).then(
              (value) => {
                setWorkspace(value.cwd);
                setWorkspaceDialog(false);
                navigate("/chat");
                setError("");
              },
              (cause) => setWorkspaceError(errorText(cause)),
            );
          }}
        >
          <Field label="Workspace directory">
            <input
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.target.value)}
            />
          </Field>
          <button className="primary">Use workspace</button>
        </form>
      </Modal>
      <Modal
        open={palette}
        onOpenChange={setPalette}
        title="Quick navigation"
        description="Search pages, agents and saved session titles."
      >
        <label className="search-input">
          <Command size={18} aria-hidden="true" />
          <input
            aria-label="Search commands and sessions"
            placeholder="Where would you like to go?"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <div className="command-list">
          {[
            {
              label: "New chat",
              action: () => {
                void create();
                setPalette(false);
              },
            },
            ...[
              { label: "Chat", path: "/chat" },
              { label: "Agents", path: "/agents" },
              { label: "Library", path: "/library" },
              { label: "Settings", path: "/settings/general" },
              { label: "Appearance", path: "/settings/appearance" },
              { label: "Chat preferences", path: "/settings/chat" },
              ...sessions.items.map((item) => ({
                label: item.title,
                path: `/chat/${item.id}`,
              })),
            ].map((item) => ({
              label: item.label,
              action: () => {
                navigate(item.path);
                setPalette(false);
              },
            })),
            ...(bootstrap?.config.agents.map((name) => ({
              label: `New chat with ${name}`,
              action: () => {
                void create(name);
                setPalette(false);
              },
            })) ?? []),
          ]
            .filter((item) =>
              item.label.toLowerCase().includes(command.toLowerCase()),
            )
            .map((item, index) => (
              <button key={`${item.label}:${index}`} onClick={item.action}>
                {item.label}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            ))}
        </div>
      </Modal>
      <Modal
        open={activityOpen}
        onOpenChange={setActivityOpen}
        title="Activity"
        description="Runs continue while you navigate or close a tab."
      >
        <div className="activity-list">
          {activity.approvals.map((approval) => (
            <Link
              key={approval.id}
              href={`/chat/${approval.sessionId}`}
              onClick={() => setActivityOpen(false)}
              className="activity-row waiting"
            >
              <span>Needs approval · {approval.name}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ))}
          {running.map((op) => (
            <Link
              key={op.id}
              href={`/chat/${op.sessionId}`}
              onClick={() => setActivityOpen(false)}
              className="activity-row"
            >
              <span>
                {op.kind === "compact" ? "Compacting" : "Running"} ·{" "}
                {sessions.items.find((item) => item.id === op.sessionId)
                  ?.title ?? op.sessionId.slice(0, 8)}
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ))}
          {!running.length && !activity.approvals.length && (
            <p className="muted">No tasks need attention.</p>
          )}
          <h3>Recent</h3>
          {activity.operations
            .filter((op) => isTerminal(op.state))
            .slice(0, 8)
            .map((op) => (
              <Link
                key={op.id}
                href={`/chat/${op.sessionId}`}
                className="activity-row"
                onClick={() => setActivityOpen(false)}
              >
                <span>
                  {sessions.items.find((item) => item.id === op.sessionId)
                    ?.title ?? op.sessionId.slice(0, 8)}
                </span>
                <span className="muted">{op.state}</span>
              </Link>
            ))}
        </div>
      </Modal>
    </>
  );
}
function Chevron() {
  return (
    <span className="muted" aria-hidden="true">
      ⌄
    </span>
  );
}
