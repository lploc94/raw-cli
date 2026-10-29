import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type Ref } from "react";
import {
  Activity,
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Menu,
  PanelRight,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { Dialog, DropdownMenu } from "radix-ui";
import type { DashboardBootstrap } from "../../src/dashboard/contract.js";
import type { RunResult } from "../../src/agent.js";
import type { SessionOperation } from "../../src/sessions/operations.js";
import type { SessionSummary } from "../../src/sessions/store.js";
import type { QueuedInputView } from "../../src/sessions/view.js";
import type { AttachmentInfo } from "../../src/dashboard/attachments.js";
import type { Preferences } from "./preferences.js";
import { api, ApiError, errorText, fetchBlob, upload } from "./api.js";
import { useBackendOptions, useComposerMeta, useHome } from "./data/queries.js";
import { shortenPath } from "./workspace/workspace-state.js";
import { Skeleton, TimelineSkeleton } from "./states.js";
import { ContextPopover } from "./composer/ContextPopover.js";
import { contextCard } from "./composer/context-card.js";
import { DETAILS_ID } from "./panels/panel-state.js";
import { RequestControls } from "./composer/RequestControls.js";
import { useRequestChoice } from "./composer/useRequestChoice.js";
import type { RequestControlMeta } from "./composer/request-choice.js";
import { addQueuedInput, forgetSession, isTerminal, useSession } from "./session.js";
import { PendingMessage, Timeline } from "./timeline.js";
import { Inspector } from "./inspector.js";
import { resolveAction } from "../../src/panels/actions.js";
import type { ActionHost } from "./panels/actions.js";
import { usePanelStack } from "./panels/use-panels.js";
import { ErrorMessage, Field, Modal } from "./ui.js";
import { useRouter } from "./router.js";
import { Composer } from "./composer/Composer.js";
import { createDraftStore, type DraftStore } from "./composer/draft-store.js";
import { AttachmentChips } from "./composer/AttachmentChips.js";
import { QueuedInputs, type QueuedNotice } from "./composer/QueuedInputs.js";
import { useAttachments, type Chip } from "./composer/useAttachments.js";
import { fileProvider } from "./composer/files.js";
import { slashProvider } from "./composer/commands.js";

const NO_CONTROLS: RequestControlMeta[] = [];

/** The app shell's controls that the chat header shows in place of the toolbar. */
export interface ChatShell {
  openDrawer: () => void;
  openSearch: () => void;
  openActivity: () => void;
  approvals: number;
  running: number;
}

const NO_INTERACTIONS: NonNullable<ActionHost["interactions"]> = [];

/** The composer, the only subscriber of the draft: a keystroke re-renders it and nothing else (docs/chat-design.md §10). */
function ComposerArea({
  store,
  blocked,
  hasContent,
  stop,
  ...composer
}: Omit<ComponentProps<typeof Composer>, "draft" | "onDraft" | "sendDisabled"> & {
  store: DraftStore;
  /** Send is disabled whatever the draft: no session yet, sending, owned elsewhere, uploading, no agent, or an unconfirmed request. */
  blocked: boolean;
  hasContent: boolean;
}) {
  const draft = useSyncExternalStore(store.subscribe, store.get);
  const empty = !draft.trim() && !hasContent;
  // While the agent works, an empty box offers Stop; a message offers Send, which waits for the current step.
  return <Composer {...composer} {...(stop && empty ? { stop } : {})} draft={draft} onDraft={store.set} sendDisabled={blocked || empty} />;
}

/**
 * The row above the first entry while older history remains (docs/chat-design.md §10): a status while a page loads, the
 * error and Retry after a page failed. Memoized so a streamed answer does not render it again.
 */
const HistoryLoader = memo(function HistoryLoader({ rowRef, loading, error, onRetry }: {
  rowRef: Ref<HTMLDivElement>;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="history-loader" ref={rowRef} role="status">
      {loading && "Loading earlier messages…"}
      {error && (
        <>
          <ErrorMessage>{error}</ErrorMessage>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </div>
  );
});

/** What a sent message holds, so its bubble can send it again or put it back in the message box (docs/chat-design.md §5). */
interface Sent {
  /** The message box's text; `input` is what the agent gets (an attachment-only message has a line of its own). */
  draft: string;
  input: string;
  images: Chip[];
  files: Chip[];
}
/** The message this page sends: its bubble shows it until the session's operations take over at the receipt. */
interface Outgoing extends Sent {
  clientRequestId: string;
  status: "sending" | "sent" | "not_sent" | "not_confirmed";
  error?: string;
}
/** Where `POST /inputs` put a message (docs/dashboard-api.md): a turn it started, the queue, or a running turn that took it. */
type InputReply = { operation?: SessionOperation; queued?: QueuedInputView; delivered?: { operationId: string; historySequence: number } };
const sentStorageKey = (sessionId: string) => `raw.dashboard.sent.${sessionId}`;
/** The messages a tab remembers attachments for. */
const SENT_REMEMBERED = 20;
/** Remembers a message's file references and image names in this tab, so after a reload its bubble can still retry and edit it. */
function rememberSent(sessionId: string, clientRequestId: string, sent: Sent) {
  if (!sent.images.length && !sent.files.length) return;
  try {
    const entries = Object.entries(JSON.parse(sessionStorage.getItem(sentStorageKey(sessionId)) ?? "{}") as Record<string, unknown>)
      .filter(([key]) => key !== clientRequestId).slice(1 - SENT_REMEMBERED);
    entries.push([clientRequestId, { files: sent.files.map((chip) => chip.path), images: sent.images.map((chip) => chip.name) }]);
    sessionStorage.setItem(sentStorageKey(sessionId), JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}
function recallSent(sessionId: string, clientRequestId: string): { files: string[]; images: string[] } {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  try {
    const entry = (JSON.parse(sessionStorage.getItem(sentStorageKey(sessionId)) ?? "{}") as Record<string, { files?: unknown; images?: unknown } | undefined>)[clientRequestId];
    return { files: strings(entry?.files), images: strings(entry?.images) };
  } catch {
    return { files: [], images: [] };
  }
}
const fileChip = (path: string, index: number): Chip =>
  ({ key: `sent-file-${index}`, type: "file", kindId: "file", name: path.split("/").at(-1) ?? path, path, status: "ready" });

/** How far `entry` is below the top of the conversation viewport. */
const entryOffset = (entry: Element, viewport: HTMLElement) =>
  entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
/** The first conversation entry that reaches into the viewport, and its offset. The loader row stays first, so it is no anchor. */
function firstEntryInView(viewport: HTMLElement) {
  const entries = viewport.querySelector(".conversation")?.children ?? [];
  for (const element of entries) {
    if (element.classList.contains("history-loader")) continue;
    const offset = entryOffset(element, viewport);
    if (offset + element.getBoundingClientRect().height > 0) return { element, offset };
  }
  return undefined;
}

export function Chat({
  id,
  shell,
  summary,
  bootstrap,
  preferences,
  drafts,
  onNewChat,
  onChanged,
  resizeInspector,
}: {
  id: string;
  shell: ChatShell;
  /** Known before the stream connects (from the session list), so the header never blanks. */
  summary: SessionSummary | undefined;
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
    error: streamError,
    earlier,
    receipt,
  } = useSession(id, bootstrap.remote);
  const { navigate } = useRouter();
  const store = useMemo(() => createDraftStore(id, drafts), [id, drafts]);
  const [agent, setAgent] = useState(() =>
    summary?.agentName && bootstrap.config.agents.includes(summary.agentName)
      ? summary.agentName
      : "",
  );
  const pickedAgent = useRef(false);
  const pickAgent = (name: string) => {
    pickedAgent.current = true;
    setAgent(name);
  };
  const { meta, metaFor } = useComposerMeta(agent);
  const backend = metaFor === agent ? meta.backend : undefined;
  const discovered = useBackendOptions(agent, !!backend);
  // A backend session lists what its CLI offered when last asked; before its first turn, what a new conversation offers.
  const sessionOptions = state?.session.agentName === agent ? state?.backendOptions : undefined;
  const controls = useMemo(
    () => (backend ? (sessionOptions ?? discovered.data?.controls ?? NO_CONTROLS) : meta.controls),
    [backend, sessionOptions, discovered.data, meta.controls],
  );
  const request = useRequestChoice(id, agent, controls, backend && !sessionOptions && !discovered.data ? "" : metaFor);
  const skills = meta.skills;
  const att = useAttachments(id, meta.attachmentKinds);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [inspector, setInspector] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState("");
  const [unconfirmed, setUnconfirmed] = useState<string>();
  const [outgoing, setOutgoing] = useState<Outgoing>();
  const showQueued = (item: QueuedInputView) => setState((old) => addQueuedInput(old, item));
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:1199px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:1199px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const inspectorOpen = useRef(false);
  inspectorOpen.current = inspector;
  /** Set when the side panel opens by itself, so the dialog does not take focus from what the user is doing. */
  const keepFocus = useRef(false);
  const openSide = useCallback(() => setInspector(true), []);
  const autoOpen = useCallback(() => {
    if (!inspectorOpen.current) keepFocus.current = true;
    setInspector(true);
  }, []);
  const panels = usePanelStack({
    sessionId: id,
    state,
    setState,
    agent,
    narrow,
    panelOpen: preferences.panelOpen,
    openSide,
    autoOpen,
  });
  const insertRef = useCallback((path: string) => {
    const current = store.get();
    store.set(`${current}${current && !/\s$/.test(current) ? " " : ""}@${path} `);
  }, [store]);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const following = useRef(preferences.follow);
  const [atBottom, setAtBottom] = useState(true);
  const prepending = useRef(false);
  /** The scroll position at the last scroll event: only scrolling up leaves the latest message. */
  const lastTop = useRef(0);
  const conversation = useRef<HTMLDivElement>(null);
  const current = state?.operations.find((op) => !isTerminal(op.state));
  const busy = pending || !!current || state?.ownership === "elsewhere";
  const [confirming, setConfirming] = useState<{ message: string; go: () => void }>();
  const savedAgent = state?.session.agentName;
  // The Timeline's actions stay the same object while their questions and blocked reason do; `run` reads the rest when it runs.
  const latest = useRef({ busy, agent, savedAgent, receipt, onChanged });
  latest.current = { busy, agent, savedAgent, receipt, onChanged };
  const interactions = state?.interactions ?? NO_INTERACTIONS;
  const toolBlocked = busy ? "Wait for the current operation to finish" : agent && savedAgent && agent !== savedAgent ? `Send a message to switch to ${agent} first` : undefined;
  const panelActions = useMemo<ActionHost>(() => ({
    interactions,
    respond: (request, submission) => api(`/sessions/${id}/interactions/${encodeURIComponent(request.identity.requestId)}/responses`, "POST", submission),
    toolBlocked,
    run: (item, action, request) => {
      const { busy, agent, savedAgent, receipt, onChanged } = latest.current;
      const go = () => {
        if (action.kind === "prompt") {
          let text: string;
          try { text = resolveAction(item.declaration, request, item.document).text ?? ""; } catch (cause) { setError(errorText(cause)); return; }
          if (action.send && !busy) {
            void api<SessionOperation>(`/sessions/${id}/operations`, "POST", { clientRequestId: crypto.randomUUID(), kind: "turn", agent, input: text }).then((op) => { receipt(op); onChanged(); }, (cause) => setError(errorText(cause)));
          } else {
            store.set(text);
            input.current?.focus();
          }
          return;
        }
        setError("");
        void api(`/sessions/${id}/${item.instanceId ? "views" : "panels"}/${encodeURIComponent(item.instanceId ?? item.panel)}/actions`, "POST", { ...request, agent: savedAgent, clientRequestId: crypto.randomUUID() })
          .then(() => onChanged(), (cause) => setError(errorText(cause)));
      };
      if (action.confirm) setConfirming({ message: action.confirm, go }); else go();
    },
  }), [interactions, toolBlocked, id, store]);
  useEffect(() => {
    setError("");
    following.current = preferences.follow;
    setUnconfirmed(undefined);
    setOutgoing(undefined);
  }, [id, drafts]);
  // The agent from the session list is only provisional (it may predate a later turn). Once the
  // stream reports the saved agent, follow it unless the user picked one in this chat.
  useEffect(() => {
    if (!state || pickedAgent.current) return;
    const saved = state.session.agentName;
    if (saved && saved !== agent && bootstrap.config.agents.includes(saved)) setAgent(saved);
  }, [state?.session.agentName, agent, bootstrap.config.agents]);
  useEffect(() => {
    following.current = preferences.follow;
  }, [preferences.follow]);
  /** Set while scrollToBottom checks the next frames, so updates in between do not start more checks. */
  const settling = useRef(false);
  /**
   * Scrolls to the bottom, then again on the next frames while the content height still changes, at most three times:
   * an entry that renders for the first time replaces its size estimate (docs/chat-design.md §10).
   */
  const scrollToBottom = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    if (settling.current) return;
    settling.current = true;
    let height = element.scrollHeight;
    let left = 3;
    const again = () => {
      const current = scroll.current;
      if (!current || !following.current || prepending.current || left-- === 0 || current.scrollHeight === height) {
        settling.current = false;
        return;
      }
      height = current.scrollHeight;
      current.scrollTop = height;
      requestAnimationFrame(again);
    };
    requestAnimationFrame(again);
  }, []);
  /**
   * While an earlier page joins the timeline: the entry in view and its offset, which it keeps from that commit on, and the
   * scroll position and height for a timeline without entries. Jump to latest clears it.
   */
  const keepInPlace = useRef<{ anchor: { element: Element; offset: number } | undefined; top: number; height: number }>(undefined);
  useLayoutEffect(() => {
    const element = scroll.current;
    const anchor = keepInPlace.current?.anchor;
    if (element && anchor?.element.isConnected) element.scrollTop += entryOffset(anchor.element, element) - anchor.offset;
    if (following.current && !prepending.current) scrollToBottom();
    // A message being sent shows before the session changes (docs/chat-design.md §5).
  }, [state, outgoing, scrollToBottom]);
  // While following, the view stays at the bottom when the content grows after a scroll: an entry replacing its size
  // estimate, a late font or image (docs/chat-design.md §10).
  useEffect(() => {
    const content = conversation.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const element = scroll.current;
      if (element && following.current && !prepending.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const checkReceipt = async (key: string) => {
    try {
      // Resolves a message wherever it went: a turn, a queued message, or one delivered into a running turn.
      const found = await api<InputReply>(
        `/sessions/${id}/inputs?clientRequestId=${encodeURIComponent(key)}`,
      );
      if (found.operation) receipt(found.operation);
      if (found.queued) showQueued(found.queued);
      // A turn's operation tells where its message is from now on; a waiting or delivered message has its card or bubble.
      setOutgoing((old) => (old?.clientRequestId === key ? (found.operation ? { ...old, status: "sent" } : undefined) : old));
      setUnconfirmed(undefined);
      setError("");
      try {
        sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
      } catch {}
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
  const hasContent = att.images.length + att.files.length > 0;
  /**
   * Puts a message back in the message box: its text before what is typed there, its file references, and its images,
   * either the same chips (the server refused the request, so their staged items remain) or uploaded again.
   */
  const putBack = (sent: Sent, sameChips: boolean) => {
    const typed = store.get();
    if (typed !== sent.draft) store.set(typed.trim() ? `${sent.draft}\n\n${typed}` : sent.draft);
    for (const chip of sent.files) if (chip.path) att.addFileRef(chip.path);
    if (sameChips) att.restore(sent.images);
    // Each image once, however often Edit is pressed: one already back in the box keeps its chip.
    else att.addFiles(sent.images.flatMap((chip) => (chip.file && !att.chips.some((entry) => entry.file === chip.file) ? [chip.file] : [])));
    input.current?.focus();
  };
  /**
   * Sends a message as a new request; its bubble shows from this call on (docs/chat-design.md §5). `staged` are the
   * images' staged ids; without them (Retry) the images are uploaded again, since a request consumes its staged items.
   */
  const deliver = async (sent: Sent, staged: string[] | undefined, mode: "queue" | "interrupt" = "queue") => {
    const clientRequestId = crypto.randomUUID();
    rememberSent(id, clientRequestId, sent);
    setOutgoing({ ...sent, clientRequestId, status: "sending" });
    following.current = true;
    setAtBottom(true);
    const mark = (status: Outgoing["status"], error?: string) =>
      setOutgoing((old) => (old?.clientRequestId === clientRequestId ? { ...old, status, ...(error ? { error } : {}) } : old));
    let attachments = staged;
    if (!attachments) {
      // An image without a copy in this page cannot be sent again; the message is not sent without it.
      const lost = sent.images.filter((chip) => !chip.file);
      if (lost.length) {
        mark("not_sent", `Attach ${lost.map((chip) => chip.name).join(", ")} again: this page no longer has a copy`);
        putBack(sent, false);
        return;
      }
      try {
        const signal = new AbortController().signal;
        attachments = await Promise.all(
          sent.images.flatMap((chip) => (chip.file ? [upload<{ id: string }>(id, chip.file, signal).then((item) => item.id)] : [])),
        );
      } catch (cause) {
        mark("not_sent", errorText(cause));
        putBack(sent, false);
        return;
      }
    }
    try {
      sessionStorage.setItem(`raw.dashboard.pending.${id}`, clientRequestId);
    } catch {}
    try {
      // The server starts a turn when the session is idle and queues the message while a turn runs, so a turn that ends
      // while this request travels cannot race it.
      const reply = await api<InputReply>(`/sessions/${id}/inputs`, "POST", {
        clientRequestId,
        agent,
        input: sent.input,
        mode,
        ...(attachments.length ? { attachments } : {}),
        ...(sent.files.length ? { files: sent.files.map((chip) => chip.path) } : {}),
        ...(request.body ? { request: request.body } : {}),
      });
      if (reply.operation) {
        receipt(reply.operation);
        mark("sent");
      } else {
        // Its card above the composer holds it now.
        if (reply.queued) showQueued(reply.queued);
        setOutgoing((old) => (old?.clientRequestId === clientRequestId ? undefined : old));
      }
      try {
        sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
      } catch {}
      onChanged();
    } catch (cause) {
      if (!(cause instanceof ApiError)) {
        mark("not_confirmed");
        await checkReceipt(clientRequestId);
        return;
      }
      try {
        sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
      } catch {}
      mark("not_sent", errorText(cause));
      putBack(sent, !!staged);
      if (cause.code === "unknown_attachment") att.expire();
    }
  };
  const send = async (kind: "turn" | "compact", mode: "queue" | "interrupt" = "queue") => {
    const draft = store.get();
    if (
      !state ||
      submitting.current ||
      // A turn message waits for the agent; only another process holding the session refuses it.
      (kind === "compact" ? busy : state.ownership === "elsewhere") ||
      !agent ||
      (kind === "turn" && (att.uploading || (!draft.trim() && !hasContent)))
    )
      return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      if (kind === "turn") {
        const images = att.images;
        const files = att.files;
        // An attachment-only turn still needs text; the model input is never empty.
        const text = draft.trim()
          ? draft
          : images.length
            ? `Please look at the attached image${images.length > 1 ? "s" : ""}.`
            : "Please look at the referenced file" + (files.length > 1 ? "s." : ".");
        // The message leaves the box at once; its bubble holds it from here (docs/chat-design.md §5).
        store.set("");
        att.consume([...images, ...files].map((chip) => chip.key));
        await deliver({ draft, input: text, images, files }, images.map((chip) => chip.serverId!), mode);
        return;
      }
      const clientRequestId = crypto.randomUUID();
      try {
        sessionStorage.setItem(`raw.dashboard.pending.${id}`, clientRequestId);
      } catch {}
      try {
        const op = await api<SessionOperation>(`/sessions/${id}/operations`, "POST", { clientRequestId, kind, agent });
        receipt(op);
        try {
          sessionStorage.removeItem(`raw.dashboard.pending.${id}`);
        } catch {}
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
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  /** Waiting messages with an action in flight or that turned out already sent; their card stays until the action ends. */
  const [notices, setNotices] = useState<ReadonlyMap<string, { item: QueuedInputView; notice: QueuedNotice }>>(() => new Map());
  useEffect(() => setNotices(new Map()), [id]);
  const setNotice = (item: QueuedInputView, notice?: QueuedNotice) =>
    setNotices((old) => {
      const next = new Map(old);
      if (notice) next.set(item.id, { item, notice });
      else next.delete(item.id);
      return next;
    });
  const dropInput = (inputId: string) =>
    setState((old) => (old ? { ...old, inputs: old.inputs.filter((entry) => entry.id !== inputId) } : old));
  /** Runs Edit, Delete or Send now on a waiting message; one the agent took meanwhile says Already sent for a moment. */
  const onCard = async (item: QueuedInputView, action: () => Promise<void>) => {
    setNotice(item, "working");
    try {
      await action();
      setNotice(item);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "already_sent") {
        setNotice(item, "already_sent");
        setTimeout(() => setNotice(item), 2500);
        return;
      }
      setNotice(item);
      // A message deleted in another tab is simply gone.
      if (cause instanceof ApiError && (cause.code === "deleted" || cause.status === 404)) dropInput(item.id);
      else setError(errorText(cause));
    }
  };
  const inputPath = (item: QueuedInputView) => `/sessions/${id}/inputs/${encodeURIComponent(item.id)}`;
  /** Puts a waiting message back in the message box, before what is typed there, with its files and its images staged again. */
  const editInput = (item: QueuedInputView) =>
    void onCard(item, async () => {
      const back = await api<{ input: string; files: string[]; attachments: AttachmentInfo[] }>(`${inputPath(item)}/edit`, "POST", {});
      dropInput(item.id);
      // A copy of each image in this page, as for an upload, so Retry can send it again after this send consumes it.
      // Read first: the message comes back whole, so it is never sent without its images.
      const images = await Promise.all(back.attachments.map(async (staged) => ({ ...staged,
        file: await fetchBlob(`/sessions/${id}/attachments/${encodeURIComponent(staged.id)}`)
          .then((blob) => new File([blob], staged.name, { type: staged.mimeType }), () => undefined) })));
      const typed = store.get();
      store.set(typed.trim() ? `${back.input}\n\n${typed}` : back.input);
      for (const path of back.files) att.addFileRef(path);
      att.addStaged(images);
      input.current?.focus();
    });
  const deleteInput = (item: QueuedInputView) =>
    void onCard(item, async () => {
      await api(inputPath(item), "DELETE");
      dropInput(item.id);
    });
  const sendNow = (item: QueuedInputView) =>
    void onCard(item, async () => {
      const reply = await api<InputReply>(`${inputPath(item)}/send-now`, "POST", {});
      following.current = true;
      setAtBottom(true);
      if (reply.operation) {
        receipt(reply.operation);
        dropInput(item.id);
        onChanged();
      } else if (reply.queued) {
        const queued = reply.queued;
        setState((old) => (old ? { ...old, inputs: old.inputs.map((entry) => (entry.id === queued.id ? queued : entry)) } : old));
      }
    });
  const queuedItems = useMemo(() => {
    const items = state?.inputs ?? [];
    const held = [...notices.values()].map(({ item }) => item).filter((item) => !items.some((entry) => entry.id === item.id));
    return held.length ? [...items, ...held].sort((a, b) => a.createdAt - b.createdAt) : items;
  }, [state?.inputs, notices]);
  const queuedNotices = useMemo(() => new Map([...notices].map(([key, value]) => [key, value.notice])), [notices]);
  const lastEditable = [...queuedItems].reverse().find((item) => !notices.has(item.id) && item.state !== "delivering");
  /**
   * The latest turn when the agent has not received its message: waiting while it starts, not delivered once it ended.
   * Delivery is the operation's committed position, so a message outside the loaded history still counts as received.
   */
  const latestTurn = state?.operations.reduce<SessionOperation | undefined>(
    (latest, op) => (op.kind === "turn" && (!latest || op.acceptedAt > latest.acceptedAt) ? op : latest), undefined);
  const unreceived =
    latestTurn && latestTurn.committedUserPosition === undefined
    && !state!.history.items.some((item) => item.kind === "user" && item.operationId === latestTurn.id)
      ? latestTurn
      : undefined;
  const ownSend = unreceived && outgoing?.clientRequestId === unreceived.clientRequestId ? outgoing : undefined;
  const recalled = useMemo(
    () => (unreceived && !ownSend ? recallSent(id, unreceived.clientRequestId) : undefined),
    [id, unreceived?.clientRequestId, !!ownSend],
  );
  const recalledSent = useMemo<Sent | undefined>(
    () => recalled && { draft: unreceived!.input ?? "", input: unreceived!.input ?? "", images: [], files: recalled.files.map(fileChip) },
    // The recalled entry and the input belong to the same operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recalled],
  );
  const unreceivedSent = ownSend ?? recalledSent;
  const unreceivedRef = useRef(unreceivedSent);
  unreceivedRef.current = unreceivedSent;
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  const putBackRef = useRef(putBack);
  putBackRef.current = putBack;
  const retryUnreceived = useCallback(() => {
    const sent = unreceivedRef.current;
    if (!sent || submitting.current || latest.current.busy || !latest.current.agent) return;
    submitting.current = true;
    setPending(true);
    setError("");
    void deliverRef.current(sent, undefined).finally(() => {
      submitting.current = false;
      setPending(false);
    });
  }, []);
  const editUnreceived = useCallback(() => {
    const sent = unreceivedRef.current;
    if (sent) putBackRef.current(sent, false);
  }, []);
  // A message the agent received no longer needs its chips in memory.
  useEffect(() => {
    if (outgoing?.status !== "sent") return;
    if (state?.operations.some((op) => op.clientRequestId === outgoing.clientRequestId && op.committedUserPosition !== undefined))
      setOutgoing(undefined);
  }, [outgoing, state?.operations]);
  // The stream can report the operation before the receipt arrives; from then on the operation tells where the message is.
  const shownOutgoing = outgoing && outgoing.status !== "sent"
    && !state?.operations.some((op) => op.clientRequestId === outgoing.clientRequestId) ? outgoing : undefined;
  const unreceivedReason = unreceived && isTerminal(unreceived.state)
    ? unreceived.state === "cancelled" || unreceived.state === "interrupted"
      ? "Stopped before the agent received it"
      : unreceived.error?.message ?? (unreceived.result as RunResult | undefined)?.message ?? unreceived.state
    : undefined;
  const pendingMessage = shownOutgoing
    ? {
        operationId: undefined,
        node: (
          <PendingMessage
            text={shownOutgoing.input}
            attachments={[...shownOutgoing.images, ...shownOutgoing.files].map((chip) => ({ name: chip.name }))}
            status={shownOutgoing.status as "sending" | "not_sent" | "not_confirmed"}
            reason={shownOutgoing.status === "not_sent" ? shownOutgoing.error : undefined}
          />
        ),
      }
    : unreceived
      ? {
          operationId: unreceived.id,
          node: (
            <PendingMessage
              text={unreceived.input ?? ""}
              attachments={ownSend
                ? [...ownSend.images, ...ownSend.files].map((chip) => ({ name: chip.name }))
                : [...(recalled?.images ?? []).map((name) => ({ name, again: true })), ...(recalledSent?.files ?? []).map((chip) => ({ name: chip.name }))]}
              status={unreceivedReason === undefined ? "waiting" : "not_delivered"}
              reason={unreceivedReason}
              {...(unreceivedReason !== undefined ? { onRetry: retryUnreceived, onEdit: editUnreceived } : {})}
            />
          ),
        }
      : undefined;
  /** One earlier page at a time; after a failure, loading on scroll waits for Retry. */
  const loadingHistory = useRef(false);
  const historyFailed = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const loaderRow = useRef<HTMLDivElement>(null);
  /** Whether the loader row is within 600 px of the top of the viewport (docs/chat-design.md §10). */
  const loaderNear = () => {
    const row = loaderRow.current;
    const element = scroll.current;
    return !!row && !!element && row.getBoundingClientRect().bottom > element.getBoundingClientRect().top - 600;
  };
  const loadEarlier = async () => {
    if (!scroll.current || loadingHistory.current || historyFailed.current) return;
    loadingHistory.current = true;
    setHistoryLoading(true);
    const done = () => {
      prepending.current = false;
      keepInPlace.current = undefined;
      loadingHistory.current = false;
      setHistoryLoading(false);
    };
    // Taken when the page has arrived, so scrolling while it loads is not undone. The first entry in view keeps its place
    // from the commit that adds the page; entries that render for the first time replace their size estimate on the next
    // frames (docs/chat-design.md §10), so the place is kept for three more frames.
    try {
      await earlier(() => {
        const element = scroll.current;
        prepending.current = true;
        if (element) keepInPlace.current = { anchor: firstEntryInView(element), top: element.scrollTop, height: element.scrollHeight };
      });
      let left = 4;
      const settle = () => {
        const element = scroll.current;
        const kept = keepInPlace.current;
        if (element && kept?.anchor?.element.isConnected)
          element.scrollTop += entryOffset(kept.anchor.element, element) - kept.anchor.offset;
        else if (element && kept && left === 4) element.scrollTop = kept.top + element.scrollHeight - kept.height;
        if (element && kept?.anchor && --left > 0) return void requestAnimationFrame(settle);
        done();
        // The observer reports only changes: a loader that is still near the top asks for the next page here.
        if (loaderNear()) void loadEarlierRef.current();
      };
      requestAnimationFrame(settle);
    } catch (cause) {
      done();
      historyFailed.current = true;
      setHistoryError(errorText(cause));
    }
  };
  const loadEarlierRef = useRef(loadEarlier);
  loadEarlierRef.current = loadEarlier;
  const retryEarlier = useCallback(() => {
    historyFailed.current = false;
    setHistoryError("");
    void loadEarlierRef.current();
  }, []);
  const hasEarlier = !!state?.history.nextCursor;
  useEffect(() => {
    historyFailed.current = false;
    setHistoryError("");
  }, [id]);
  useEffect(() => {
    const row = loaderRow.current;
    const root = scroll.current;
    if (!row || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadEarlierRef.current();
      },
      { root, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [id, hasEarlier]);
  const title_ = state?.session.title ?? summary?.title;
  const cwd_ = state?.session.cwd ?? summary?.cwd;
  const home = useHome();
  const metrics = state?.metrics;
  const context = metrics?.context;
  const milestone = state?.approvals.length
    ? "Waiting for approval"
    : state?.interactions?.some(request => request.state === "pending")
      ? "Waiting for your answer"
    : current?.state === "starting" || current?.state === "accepted" || (pending && !current)
      ? "Preparing"
      : current?.state === "compacting"
        ? "Compacting"
        : current
          ? "Working"
          : state?.ownership === "elsewhere"
            ? "Active elsewhere"
            : "Ready";
  // The visible status line names only what the timeline does not show (docs/chat-design.md §7): the running group says
  // Working, the approval card Waiting for approval, an inline question card itself. The live region announces them all.
  const visibleMilestone = milestone === "Preparing" || milestone === "Compacting"
    || (milestone === "Waiting for your answer"
      && !state?.interactions?.some((request) => request.state === "pending" && request.declaration.placement === "chat"));
  const compactDisabled = !state
    ? "Session is loading"
    : !agent
      ? "Choose an agent first"
      : busy
        ? "Wait for the current work to finish"
        : undefined;
  const files = useMemo(
    () => fileProvider(id, att.addFileRef),
    [id, att.addFileRef],
  );
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
      files,
    ],
    // `send` closes over live state; the rebuilt provider only needs to track what changes the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, compactDisabled, state, agent, busy, files],
  );
  return (
    <Dialog.Root open={inspector} onOpenChange={setInspector} modal={narrow}>
      <div className={`chat-workspace ${inspector ? "has-inspector" : ""}`}>
        <section className="chat-main" aria-label="Conversation">
          <header className="page-header chat-header">
            <button className="icon-button mobile-nav" aria-label="Workspace menu" title="Workspace menu" onClick={shell.openDrawer}>
              <Menu size={17} aria-hidden="true" />
            </button>
            <div className="chat-title">
              {title_ ? <h1 title={title_}>{title_}</h1> : <h1 aria-label="Loading session"><Skeleton width={30} className="skeleton-title" /></h1>}
              <div className="metadata">
                {agent && <span className="agent-chip" title={agent}>{agent}</span>}
                {backend && <span className="badge backend-badge" title={`Runs ${backend.label}`}>{backend.label}</span>}
                <span className="workspace-path" title={cwd_}>
                  {cwd_ ? shortenPath(cwd_, home) : <Skeleton width={50} className="skeleton-small" />}
                </span>
              </div>
            </div>
            <div className="actions">
              <button className="icon-button chat-search" aria-label="Quick navigation" title="Quick navigation (⌘K)" onClick={shell.openSearch}>
                <Search size={16} aria-hidden="true" />
              </button>
              <button
                className={`icon-button chat-activity ${shell.approvals ? "attention" : ""}`}
                aria-label={`Activity${shell.approvals ? ` · ${shell.approvals} approvals` : ""}`}
                title="Activity"
                onClick={shell.openActivity}
              >
                <Activity size={16} aria-hidden="true" />
                {shell.running > 0 && <span className="count">{shell.running}</span>}
              </button>
              <Dialog.Trigger asChild>
                <button
                  className={`icon-button ${inspector ? "selected" : ""}`}
                  aria-label="Side panel"
                  title="Side panel"
                >
                  <PanelRight size={16} aria-hidden="true" />
                </button>
              </Dialog.Trigger>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="icon-button" aria-label="More actions" title="More actions" disabled={!state}>
                    <MoreHorizontal size={16} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={6} collisionPadding={8}>
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className="workspace-menu-item" disabled={!!busy} title={busy ? "Stop the active operation before changing the agent" : undefined}>
                        <Bot size={15} aria-hidden="true" />
                        Agent: {agent || "none"}
                        <ChevronRight size={14} aria-hidden="true" className="menu-chevron" />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent className="workspace-menu" sideOffset={4} collisionPadding={8}>
                          <DropdownMenu.RadioGroup value={agent} onValueChange={pickAgent}>
                            {bootstrap.config.agents.map((name) => (
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
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    <DropdownMenu.Item
                      className="workspace-menu-item"
                      onSelect={() => {
                        setTitle(state!.session.title);
                        setDialogError("");
                        setRenaming(true);
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      Rename session
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="workspace-menu-item"
                      onSelect={() => {
                        void navigator.clipboard?.writeText(state!.session.cwd).catch(() => undefined);
                      }}
                    >
                      <Copy size={15} aria-hidden="true" />
                      Copy workspace path
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="workspace-menu-separator" />
                    <DropdownMenu.Item
                      className="workspace-menu-item danger-item"
                      disabled={!!busy}
                      title={busy ? "Stop the active operation before deleting" : undefined}
                      onSelect={() => {
                        setDialogError("");
                        setDeleting(true);
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      Delete session
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </header>
          <div
            className="conversation-scroll"
            ref={scroll}
            onScroll={() => {
              if (!scroll.current) return;
              const el = scroll.current;
              const up = el.scrollTop < lastTop.current;
              lastTop.current = el.scrollTop;
              if (prepending.current) return;
              const bottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              // Content growing below moves the bottom away without you; only scrolling up stops following.
              if (bottom) following.current = preferences.follow;
              else if (up) following.current = false;
              setAtBottom(bottom);
            }}
          >
            <div className="conversation" ref={conversation}>
              <ErrorMessage>{streamError}</ErrorMessage>
              {(hasEarlier || historyError) && (
                <HistoryLoader rowRef={loaderRow} loading={historyLoading} error={historyError} onRetry={retryEarlier} />
              )}
              {!state && !streamError && <TimelineSkeleton />}
              {state && <Timeline state={state} preferences={preferences} onOpenPanel={panels.show} actions={panelActions} onInsert={insertRef} pending={pendingMessage} />}
              {state && !state.history.items.length && !current && !pendingMessage && (
                <div className="chat-intro">
                  <h2>What would you like to work on?</h2>
                  <p className="muted">
                    Your agent works in this session’s workspace. Describe the
                    task to begin.
                  </p>
                </div>
              )}
              {current && visibleMilestone && !(milestone === "Preparing" && pendingMessage) && (
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
              {/* A message the agent did not get says why in its bubble. */}
              {state?.operations[0] && state.operations[0].id !== unreceived?.id && state.operations[0].error && (
                <ErrorMessage>{state.operations[0].error.message}</ErrorMessage>
              )}
              {state?.operations[0] && state.operations[0].id !== unreceived?.id && state.operations[0].state === "interrupted" && (
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
                  // Leaving for the bottom ends the correction of an earlier page that still keeps an entry in place.
                  keepInPlace.current = undefined;
                  scrollToBottom();
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
                    // The message goes back in the message box; a receipt that shows up later still reaches the timeline.
                    if (outgoing?.status === "not_confirmed") {
                      putBack(outgoing, true);
                      setOutgoing(undefined);
                    }
                  }}
                >
                  Dismiss check and keep draft
                </button>
              </div>
            )}
            <QueuedInputs items={queuedItems} notices={queuedNotices} onEdit={editInput} onDelete={deleteInput} onSendNow={sendNow} />
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send("turn");
              }}
            >
              <ComposerArea
                store={store}
                inputRef={input}
                onSend={() => void send("turn")}
                blocked={!state || pending || state.ownership === "elsewhere" || att.uploading || !agent || !!unconfirmed}
                hasContent={hasContent}
                chips={
                  <AttachmentChips
                    chips={att.chips}
                    metas={meta.attachmentKinds}
                    onRemove={att.remove}
                    onRetry={att.retry}
                  />
                }
                controls={
                  <RequestControls
                    controls={controls}
                    choice={request.choice}
                    onChange={request.update}
                  />
                }
                context={
                  <ContextPopover
                    card={contextCard(context, { stale: !!state?.metricsStale, messages: state?.context.messageCount })}
                    compact={{ run: () => { void send("compact"); }, disabled: compactDisabled }}
                    onDetails={() => panels.show(DETAILS_ID)}
                  />
                }
                onFiles={att.addFiles}
                accept={
                  meta.attachmentKinds.flatMap((kind) => kind.accept).join(",") ||
                  "image/png,image/jpeg"
                }
                {...(!meta.vision &&
                state?.history.items.some((item) =>
                  item.attachments?.some((entry) => entry.kind === "image"),
                )
                  ? {
                      note: "Images in this chat are sent to this agent as text placeholders.",
                    }
                  : backend && !sessionOptions && discovered.data?.warning
                    ? { note: `${backend.label} could not be asked for its models: ${discovered.data.warning}. Turns use the agent's settings.` }
                    : {})}
                sendMode={preferences.sendMode}
                providers={providers}
                {...(current && state?.ownership === "here"
                  ? {
                      stop: () => {
                        void api(`/operations/${current.id}/cancel`, "POST").catch(
                          (cause) => setError(errorText(cause)),
                        );
                      },
                      onInterrupt: () => void send("turn", "interrupt"),
                    }
                  : {})}
                {...(lastEditable ? { onEditLast: () => editInput(lastEditable) } : {})}
              />
            </form>
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
            keepFocus={keepFocus}
            compact={{ run: () => { void send("compact"); }, disabled: !!compactDisabled }}
            stack={{
              agent: panels.stackAgent,
              items: panels.items,
              prefs: panels.prefs,
              setPrefs: panels.setPrefs,
              history: state?.history.items ?? [],
              onInsert: insertRef,
              actions: panelActions,
            }}
          />
        )}
        <Modal open={!!confirming} onOpenChange={(open) => { if (!open) setConfirming(undefined); }} title="Run this action?" {...(confirming ? { description: confirming.message } : {})}>
          <button className="primary" type="button" onClick={() => { const go = confirming?.go; setConfirming(undefined); go?.(); }}>
            <Check size={15} aria-hidden="true" />
            Run
          </button>
        </Modal>
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
                    forgetSession(id);
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
