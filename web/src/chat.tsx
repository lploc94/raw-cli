import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Brain,
  Check,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import { Dialog } from "radix-ui";
import type { DashboardBootstrap } from "../../src/dashboard/contract.js";
import type { SessionOperation } from "../../src/sessions/operations.js";
import type { SessionSummary } from "../../src/sessions/store.js";
import type { Preferences } from "./preferences.js";
import { api, ApiError, errorText } from "./api.js";
import { isTerminal, useSession } from "./session.js";
import { Timeline } from "./timeline.js";
import { Inspector } from "./inspector.js";
import { ErrorMessage, Field, Modal } from "./ui.js";
import { useRouter } from "./router.js";
import { Composer } from "./composer/Composer.js";
import { slashProvider, type ComposerSkill } from "./composer/commands.js";

export function Chat({
  id,
  bootstrap,
  preferences,
  drafts,
  onNewChat,
  onChanged,
  resizeInspector,
}: {
  id: string;
  bootstrap: DashboardBootstrap;
  preferences: Preferences;
  drafts: Map<string, string>;
  onNewChat: () => void;
  onChanged: () => void;
  resizeInspector: (width: number) => void;
}) {
  const {
    state,
    setState,
    connection,
    error: streamError,
    earlier,
    receipt,
  } = useSession(id);
  const { navigate } = useRouter();
  const [draft, setDraft] = useState(drafts.get(id) ?? "");
  const [agent, setAgent] = useState("");
  const [skills, setSkills] = useState<ComposerSkill[]>([]);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [inspector, setInspector] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState("");
  const [unconfirmed, setUnconfirmed] = useState<string>();
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:1199px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:1199px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const following = useRef(preferences.follow);
  const [atBottom, setAtBottom] = useState(true);
  const prepending = useRef(false);
  const current = state?.operations.find((op) => !isTerminal(op.state));
  const busy = pending || !!current || state?.ownership === "elsewhere";
  useEffect(() => {
    setDraft(drafts.get(id) ?? "");
    setAgent("");
    setError("");
    following.current = preferences.follow;
    setUnconfirmed(undefined);
  }, [id, drafts]);
  useEffect(() => {
    if (!state || agent) return;
    const saved = state.session.agentName;
    if (saved && bootstrap.config.agents.includes(saved)) setAgent(saved);
  }, [state?.session.agentName, agent, bootstrap.config.agents]);
  useEffect(() => {
    following.current = preferences.follow;
  }, [preferences.follow]);
  useLayoutEffect(() => {
    if (scroll.current && following.current && !prepending.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state]);
  useEffect(() => {
    setSkills([]);
    if (!agent) return;
    let live = true;
    void api<{ skills: ComposerSkill[] }>(
      `/agents/${encodeURIComponent(agent)}/composer`,
    )
      .then((meta) => live && setSkills(meta.skills))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agent]);
  const checkReceipt = async (key: string) => {
    try {
      const op = await api<SessionOperation>(
        `/sessions/${id}/operations?clientRequestId=${encodeURIComponent(key)}`,
      );
      receipt(op);
      setUnconfirmed(undefined);
      setError("");
      try {
        sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
      } catch {}
      if (op.kind === "turn") {
        setDraft((current) => (current === op.input ? "" : current));
        if (drafts.get(id) === op.input) drafts.delete(id);
      }
      onChanged();
    } catch (cause) {
      setUnconfirmed(key);
      setError(
        cause instanceof ApiError && cause.status === 404
          ? "No receipt found yet. Check again before sending another request; your draft has not been resubmitted."
          : errorText(cause),
      );
    }
  };
  useEffect(() => {
    let key: string | null = null;
    try {
      key = sessionStorage.getItem(`raw.dashboard.pending.${id}`);
    } catch {}
    if (key) void checkReceipt(key);
  }, [id, !!state]);
  const send = async (kind: "turn" | "compact") => {
    if (
      !state ||
      submitting.current ||
      busy ||
      !agent ||
      (kind === "turn" && !draft.trim())
    )
      return;
    submitting.current = true;
    setPending(true);
    setError("");
    const clientRequestId = crypto.randomUUID();
    try {
      sessionStorage.setItem(`raw.dashboard.pending.${id}`, clientRequestId);
    } catch {}
    try {
      const op = await api<SessionOperation>(
        `/sessions/${id}/operations`,
        "POST",
        {
          clientRequestId,
          kind,
          agent,
          ...(kind === "turn" ? { input: draft } : {}),
        },
      );
      receipt(op);
      try {
        sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
      } catch {}
      if (kind === "turn") {
        setDraft((current) => (current === draft ? "" : current));
        if (drafts.get(id) === draft) drafts.delete(id);
      }
      following.current = true;
      setAtBottom(true);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
      if (!(cause instanceof ApiError)) await checkReceipt(clientRequestId);
      else
        try {
          sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
        } catch {}
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const loadEarlier = async () => {
    if (!scroll.current) return;
    prepending.current = true;
    const height = scroll.current.scrollHeight;
    const top = scroll.current.scrollTop;
    try {
      await earlier();
      requestAnimationFrame(() => {
        if (scroll.current)
          scroll.current.scrollTop = top + scroll.current.scrollHeight - height;
        prepending.current = false;
      });
    } catch (cause) {
      prepending.current = false;
      setError(errorText(cause));
    }
  };
  const update = (value: string) => {
    setDraft(value);
    drafts.set(id, value);
  };
  const metrics = state?.metrics;
  const context = metrics?.context;
  const milestone = state?.approvals.length
    ? "Waiting for approval"
    : current?.state === "starting" || current?.state === "accepted" || pending
      ? "Preparing"
      : current?.state === "compacting"
        ? "Compacting"
        : current
          ? "Working"
          : state?.ownership === "elsewhere"
            ? "Active elsewhere"
            : "Ready";
  const compactDisabled = !state
    ? "Session is loading"
    : !agent
      ? "Choose an agent first"
      : busy
        ? "Wait for the current work to finish"
        : undefined;
  const providers = useMemo(
    () => [
      slashProvider(
        {
          compact: {
            run: () => void send("compact"),
            ...(compactDisabled ? { disabled: compactDisabled } : {}),
          },
          rename: () => {
            if (!state) return;
            setTitle(state.session.title);
            setDialogError("");
            setRenaming(true);
          },
          newChat: onNewChat,
          details: () => setInspector((value) => !value),
        },
        skills,
      ),
    ],
    // `send` closes over live state; the rebuilt provider only needs to track what changes the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, compactDisabled, state, agent, busy],
  );
  return (
    <Dialog.Root open={inspector} onOpenChange={setInspector} modal={narrow}>
      <div className={`chat-workspace ${inspector ? "has-inspector" : ""}`}>
        <section className="chat-main" aria-label="Conversation">
          <header className="page-header">
            <div>
              <h1>{state?.session.title ?? "Loading session…"}</h1>
              <div className="metadata">
                <span
                  className={`connection ${connection === "Connected" ? "connected" : ""}`}
                >
                  {connection}
                </span>
                <span>{milestone}</span>
              </div>
            </div>
            <div className="actions">
              <button
                className="icon-button"
                aria-label="Rename session"
                title="Rename session"
                disabled={!state}
                onClick={() => {
                  setTitle(state!.session.title);
                  setDialogError("");
                  setRenaming(true);
                }}
              >
                <Pencil size={17} aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                aria-label="Delete session"
                title={
                  busy
                    ? "Stop the active operation before deleting"
                    : "Delete session"
                }
                disabled={!state || !!busy}
                onClick={() => {
                  setDialogError("");
                  setDeleting(true);
                }}
              >
                <Trash2 size={17} aria-hidden="true" />
              </button>
              <Dialog.Trigger asChild>
                <button
                  className={`icon-button ${inspector ? "selected" : ""}`}
                  aria-label="Session details"
                >
                  <Info size={19} aria-hidden="true" />
                </button>
              </Dialog.Trigger>
            </div>
          </header>
          <div className="chat-selection">
            <Field label="Agent">
              <select
                value={agent}
                disabled={!!busy}
                onChange={(event) => setAgent(event.target.value)}
              >
                <option value="">Choose an agent</option>
                {bootstrap.config.agents.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <span className="workspace-path" title={state?.session.cwd}>
              {state?.session.cwd}
            </span>
          </div>
          <div
            className="conversation-scroll"
            ref={scroll}
            onScroll={() => {
              if (!scroll.current || prepending.current) return;
              const el = scroll.current;
              const bottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              following.current = bottom && preferences.follow;
              setAtBottom(bottom);
            }}
          >
            <div className="conversation">
              <ErrorMessage>{streamError}</ErrorMessage>
              {state?.history.nextCursor && (
                <button
                  className="load-earlier"
                  onClick={() => {
                    void loadEarlier();
                  }}
                >
                  Load earlier
                </button>
              )}
              {state && <Timeline state={state} preferences={preferences} />}
              {state && !state.history.items.length && !current && (
                <div className="chat-intro">
                  <h2>What would you like to work on?</h2>
                  <p className="muted">
                    Your agent works in this session’s workspace. Describe the
                    task to begin.
                  </p>
                </div>
              )}
              {current && (
                <p className="working-status">
                  <span className="activity-dot" />
                  {milestone}
                </p>
              )}
              {state?.ownership === "elsewhere" && (
                <p className="system-note">
                  This session is active in another CLI or ACP process.
                  Committed history refreshes automatically.
                </p>
              )}
              {state?.operations[0]?.error && (
                <ErrorMessage>{state.operations[0].error.message}</ErrorMessage>
              )}
              {state?.operations[0]?.state === "interrupted" && (
                <p className="warning">
                  The previous operation was interrupted. Inspect tool outcomes
                  before sending another turn. Nothing is replayed
                  automatically.
                </p>
              )}
            </div>
          </div>
          <div className="composer-area">
            {!atBottom && (
              <button
                className="jump-latest"
                onClick={() => {
                  following.current = true;
                  if (scroll.current)
                    scroll.current.scrollTop = scroll.current.scrollHeight;
                  setAtBottom(true);
                }}
              >
                <ArrowDown size={15} aria-hidden="true" />
                Jump to latest
              </button>
            )}
            <ErrorMessage>{error}</ErrorMessage>
            {unconfirmed && (
              <div className="actions">
                <button
                  onClick={() => {
                    void checkReceipt(unconfirmed);
                  }}
                >
                  Check submitted request
                </button>
                <button
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
                    } catch {}
                    setUnconfirmed(undefined);
                    setError("");
                  }}
                >
                  Dismiss check and keep draft
                </button>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send("turn");
              }}
            >
              <Composer
                inputRef={input}
                draft={draft}
                onDraft={update}
                onSend={() => void send("turn")}
                sendDisabled={
                  !state || !!busy || !draft.trim() || !agent || !!unconfirmed
                }
                sendMode={preferences.sendMode}
                providers={providers}
                {...(current && state?.ownership === "here"
                  ? {
                      stop: () => {
                        void api(`/operations/${current.id}/cancel`, "POST").catch(
                          (cause) => setError(errorText(cause)),
                        );
                      },
                    }
                  : {})}
              />
            </form>
            <div className="composer-footer">
              <span>
                {context
                  ? `~${context.estimatedTokens.toLocaleString()}${context.contextWindow ? ` / ${context.contextWindow.toLocaleString()} · ${context.percentage!.toFixed(1)}%` : " tokens · window unavailable"}${state?.metricsStale ? " · last measured" : ""}`
                  : "Context usage unavailable"}
              </span>
              <button
                className="text-button"
                disabled={!state || !!busy || !agent}
                title="Summarize model context while keeping visible history"
                onClick={() => {
                  void send("compact");
                }}
              >
                <Brain size={14} aria-hidden="true" />
                Compact context
              </button>
            </div>
          </div>
          <span className="sr-only" role="status" aria-live="polite">
            {milestone}
          </span>
        </section>
        {inspector && (
          <Inspector
            id={id}
            state={state}
            bootstrap={bootstrap}
            preferences={preferences}
            narrow={narrow}
            resizeInspector={resizeInspector}
          />
        )}
        <Modal
          open={renaming}
          onOpenChange={setRenaming}
          title="Rename session"
        >
          <ErrorMessage>{dialogError}</ErrorMessage>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void api<SessionSummary>(`/sessions/${id}`, "PATCH", {
                title,
              }).then(
                (session) => {
                  setState((old) => (old ? { ...old, session } : old));
                  setRenaming(false);
                  onChanged();
                },
                (cause) => setDialogError(errorText(cause)),
              );
            }}
          >
            <Field label="Session title">
              <input
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <button className="primary" type="submit">
              <Check size={15} aria-hidden="true" />
              Save title
            </button>
          </form>
        </Modal>
        <Modal
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete this session?"
          description="The saved conversation will be permanently deleted. This cannot be undone."
        >
          <ErrorMessage>{dialogError}</ErrorMessage>
          <div className="actions">
            <button onClick={() => setDeleting(false)}>Keep session</button>
            <button
              className="danger"
              onClick={() => {
                void api(`/sessions/${id}`, "DELETE").then(
                  () => {
                    setDeleting(false);
                    drafts.delete(id);
                    onChanged();
                    navigate("/chat");
                  },
                  (cause) => setDialogError(errorText(cause)),
                );
              }}
            >
              Delete permanently
            </button>
          </div>
        </Modal>
      </div>
    </Dialog.Root>
  );
}
