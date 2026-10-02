import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Command,
  Library,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { SessionSummary } from "../../src/sessions/store.js";
import { api, errorText } from "./api.js";
import { Chat } from "./chat.js";
import { mutate as globalMutate } from "swr";
import { keys } from "./data/keys.js";
import {
  prefetchComposerMeta,
  prefetchConfig,
  useActivity,
  useBootstrap,
  useSessions,
} from "./data/queries.js";
import { isTerminal } from "./session.js";
import { usePreferences } from "./preferences.js";
import { Link, useRouter } from "./router.js";
import {
  PageErrorBoundary,
  SessionRowsSkeleton,
  ShellSkeleton,
  Skeleton,
} from "./states.js";
import { Empty, ErrorMessage, Field, Modal } from "./ui.js";
import { PreferencesPage } from "./pages/Preferences.js";
import { AgentsPage } from "./pages/Agents.js";
import { PackagesPage } from "./pages/Packages.js";
import { ComponentsPage } from "./pages/Components.js";
import { DefinitionsPage } from "./pages/Definitions.js";
import { SettingsPage, SettingsSearch } from "./pages/Settings.js";
import { FolderBrowser } from "./workspace/FolderBrowser.js";
import { WorkspaceSwitcher } from "./workspace/WorkspaceSwitcher.js";
import { loadState, recordOpened, relativeTime, saveState, type WorkspaceState } from "./workspace/workspace-state.js";

/** Sidebar date buckets, newest first. */
function sessionGroup(at: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = Math.floor((start.getTime() - at) / 86_400_000) + 1;
  if (at >= start.getTime()) return "Today";
  if (days <= 1) return "Yesterday";
  return days <= 7 ? "Previous 7 days" : "Older";
}

const categories = [
  "general",
  "models",
  "appearance",
  "chat",
  "sessions",
  "diagnostics",
];
const librarySections = ["tools", "skills", "hooks", "vars", "mcp", "packages"];

export function App() {
  const { path, navigate } = useRouter();
  const currentAgent = (() => {
    const segment = path.split("/")[1] === "agents" ? path.split("/")[2] : undefined;
    try {
      return segment ? decodeURIComponent(segment) : undefined;
    } catch {
      return undefined;
    }
  })();
  const [preferences, setPreferences] = usePreferences();
  const {
    data: bootstrap,
    error: bootstrapError,
    mutate: mutateBootstrap,
  } = useBootstrap();
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(() => loadState());
  const [activityRevision, setActivityRevision] = useState(0);
  const updateWorkspaceState = useCallback((update: (old: WorkspaceState) => WorkspaceState) => {
    setWorkspaceState((old) => {
      const next = update(old);
      saveState(next);
      return next;
    });
  }, []);
  const [agent, setAgent] = useState("");
  const [filter, setFilter] = useState("");
  /** The session just created: lets its chat open with a full header even if a filter hides it from the list. */
  const [created, setCreated] = useState<SessionSummary>();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [command, setCommand] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const drafts = useRef(new Map<string, string>());
  const page = path.split("/")[1] || "chat";
  const librarySection = page === "library" ? path.split("/")[2] || "tools" : undefined;
  const main = useRef<HTMLElement>(null);
  const shownPage = useRef<string | undefined>(undefined);
  // Route transition: the DOM swaps synchronously (so clicks never hit stale UI) and the new
  // area eases in. Only whole-area changes animate (Chat/Agents/Library/Settings): opening or
  // switching a chat must appear instantly. Skipped on first paint and for reduced motion.
  useLayoutEffect(() => {
    const previous = shownPage.current;
    shownPage.current = page;
    if (previous === undefined || previous === page) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    main.current?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [page]);
  const previousActivity = useRef("[]");
  const sessionId = page === "chat" ? path.split("/")[2] : undefined;
  /** Management pages call this after a write: refresh bootstrap plus the shared `/config`. */
  const refreshBootstrap = useCallback(async () => {
    await Promise.all([mutateBootstrap(), globalMutate(keys.config())]);
  }, [mutateBootstrap]);
  useEffect(() => {
    if (!bootstrap) return;
    setWorkspace((old) => old || bootstrap.cwd);
    setAgent((old) =>
      bootstrap.config.agents.includes(old)
        ? old
        : (bootstrap.preferredAgent ??
          bootstrap.config.defaultAgent ??
          bootstrap.config.agents[0] ??
          ""),
    );
  }, [bootstrap]);
  const sessions = useSessions(workspace, filter, !!bootstrap?.store.available);
  const { mutate: mutateSessions } = sessions;
  const refreshSessions = useCallback(async () => {
    await mutateSessions();
  }, [mutateSessions]);
  const activity = useActivity(!!bootstrap?.store.available);
  useEffect(() => {
    // Refresh the list only when the set of running operations actually changes.
    const revision = JSON.stringify(
      activity.operations.map((item) => [item.id, item.state]),
    );
    if (revision === previousActivity.current) return;
    previousActivity.current = revision;
    setActivityRevision((old) => old + 1);
    void mutateSessions();
  }, [activity, mutateSessions]);
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
      setCreated(session);
      // Show the new row and open it right away; background revalidation reconciles the list.
      void mutateSessions(
        (pages) =>
          filter
            ? pages
            : pages?.length
              ? [
                  {
                    ...pages[0]!,
                    items: [
                      session,
                      ...pages[0]!.items.filter((item) => item.id !== session.id),
                    ],
                  },
                  ...pages.slice(1),
                ]
              : [{ items: [session] }],
        { revalidate: true },
      );
      navigate(`/chat/${session.id}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const chooseWorkspace = (cwd: string) => {
    setWorkspace(cwd);
    navigate("/chat");
    setError("");
  };
  const running = activity.operations.filter((op) => !isTerminal(op.state));
  const sidebar = (
    <div className="context-panel-inner">
      <WorkspaceSwitcher
        current={workspace}
        state={workspaceState}
        onState={updateWorkspaceState}
        activityRevision={activityRevision}
        onChoose={chooseWorkspace}
        onOpenFolder={() => setWorkspaceDialog(true)}
      />
      {page === "chat" ? (
        <>
          <div className="new-chat-row">
            <button
              className="primary new-chat"
              onClick={() => {
                void create();
              }}
              onPointerEnter={() => prefetchComposerMeta(agent)}
              onFocus={() => prefetchComposerMeta(agent)}
              disabled={
                !bootstrap?.config.valid || !agent || !bootstrap.store.available
              }
            >
              <Plus size={17} aria-hidden="true" />
              New chat
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="agent-picker"
                  aria-label="New chat agent"
                  title="Agent for the next new chat"
                >
                  {agent ? <span>{agent}</span> : <Skeleton width={60} />}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="workspace-menu agent-menu" align="end" sideOffset={6} collisionPadding={8}>
                  <DropdownMenu.RadioGroup value={agent} onValueChange={(name) => { setAgent(name); prefetchComposerMeta(name); }}>
                    {bootstrap?.config.agents.map((name) => (
                      <DropdownMenu.RadioItem key={name} value={name} className="workspace-menu-item">
                        <span className="agent-menu-check">
                          <DropdownMenu.ItemIndicator>
                            <Check size={14} aria-hidden="true" />
                          </DropdownMenu.ItemIndicator>
                        </span>
                        {name}
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
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
            {!bootstrap || (sessions.isLoading && !sessions.items.length) ? (
              <SessionRowsSkeleton />
            ) : sessions.items.length ? (
              sessions.items.map((session, index) => {
                const group = sessionGroup(session.updatedAt);
                const previousGroup =
                  index > 0 ? sessionGroup(sessions.items[index - 1]!.updatedAt) : "";
                const active = running.some(
                  (op) => op.sessionId === session.id,
                );
                const approval = activity.approvals.some(
                  (item) => item.sessionId === session.id,
                );
                return (
                  <div key={session.id}>
                    {group !== previousGroup && (
                      <div className="group-label">{group}</div>
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
                              : [
                                  relativeTime(session.updatedAt, Date.now()),
                                  session.agentName && session.agentName !== agent ? session.agentName : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "Saved session"}
                        </small>
                      </span>
                    </Link>
                  </div>
                );
              })
            ) : sessions.error ? (
              <p className="muted small" role="alert">
                Could not load sessions.{" "}
                <button className="text-button" onClick={() => void refreshSessions()}>
                  Try again
                </button>
              </p>
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
            {!!sessions.error && sessions.items.length > 0 && (
              <p className="muted small" role="alert">
                Could not refresh sessions.{" "}
                <button className="text-button" onClick={() => void refreshSessions()}>
                  Try again
                </button>
              </p>
            )}
            {sessions.nextCursor && (
              <button
                disabled={sessions.isLoadingMore}
                onClick={sessions.loadMore}
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
          {librarySections.map((name) => (
            <Link
              key={name}
              href={`/library/${name}`}
              aria-current={librarySection === name ? "page" : undefined}
            >
              {name === "mcp" ? "MCP" : name[0]!.toUpperCase() + name.slice(1)}
            </Link>
          ))}
        </nav>
      ) : (
        <nav aria-label="Agents" className="context-nav">
          <div className="group-label">Agents</div>
          {bootstrap?.config.agents.map((name) => (
            <Link
              key={name}
              href={`/agents/${encodeURIComponent(name)}`}
              aria-current={currentAgent === name ? "page" : undefined}
            >
              {name}
            </Link>
          ))}
          {bootstrap && !bootstrap.config.agents.length && <p className="muted context-empty">No agents yet</p>}
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
              onPointerEnter={id === "chat" ? undefined : prefetchConfig}
              onFocus={id === "chat" ? undefined : prefetchConfig}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
          <Link
            href="/settings/general"
            className={`settings-link ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            onPointerEnter={prefetchConfig}
            onFocus={prefetchConfig}
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
          <main id="main" tabIndex={-1} ref={main}>
            <ErrorMessage>{error}</ErrorMessage>
            <PageErrorBoundary resetKey={path}>
            {!bootstrap ? (
              bootstrapError ? (
                <Empty title="Connection unavailable">
                  {errorText(bootstrapError)}{" "}
                  Reopen the launch link from your terminal to connect.
                </Empty>
              ) : (
                <ShellSkeleton />
              )
            ) : page === "chat" ? (
              sessionId ? (
                <Chat
                  key={sessionId}
                  id={sessionId}
                  summary={
                    sessions.items.find((item) => item.id === sessionId) ??
                    (created?.id === sessionId ? created : undefined)
                  }
                  bootstrap={bootstrap}
                  preferences={preferences}
                  drafts={drafts.current}
                  onNewChat={() => {
                    void create();
                  }}
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
            ) : librarySection === "tools" || librarySection === "skills" || librarySection === "hooks" ? (
              <ComponentsPage key={path} kind={librarySection} changed={refreshBootstrap} />
            ) : librarySection === "vars" || librarySection === "mcp" ? (
              <DefinitionsPage key={path} kind={librarySection} changed={refreshBootstrap} />
            ) : librarySection && librarySection !== "packages" ? (
              <Empty title="Library section not found" action={<Link href="/library/tools">Open Tools</Link>}>
                There is no Library section named “{librarySection}”.
              </Empty>
            ) : (
              <PackagesPage
                key={path}
                changed={refreshBootstrap}
                createChat={create}
              />
            )}
            </PageErrorBoundary>
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
      <FolderBrowser
        open={workspaceDialog}
        onOpenChange={setWorkspaceDialog}
        initialPath={workspace}
        onOpen={(cwd) => {
          updateWorkspaceState((old) => recordOpened(old, cwd, Date.now()));
          setWorkspaceDialog(false);
          chooseWorkspace(cwd);
        }}
      />
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
