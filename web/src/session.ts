import { startTransition, useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../../src/dashboard/sessions.js";
import type {
  DashboardEvent,
  DashboardEventData,
} from "../../src/dashboard/streams.js";
import type { SessionOperation } from "../../src/sessions/operations.js";
import type { HistoryView } from "../../src/sessions/view.js";
import type { Page } from "../../src/sessions/store.js";
import { api, ApiError, errorText, subscribe } from "./api.js";
import { applyFrame } from "./panels/panel-state.js";
import { browserScheduler, createEventBatcher } from "./session-batch.js";

export type LiveTool = DashboardEventData["tool"] & { operationId: string };
export interface ChatState extends SessionSnapshot {
  views: Record<string, DashboardEventData["panel"] & { operationId: string }>;
  tools: Record<string, LiveTool>;
  compactions: Record<string, DashboardEventData["compaction"]>;
  /** Counts snapshot and reset frames: what a stream (re)connect, or an agent switch, must react to. */
  snapshotCount: number;
  /** Counts live panel frames, for a stack shown for an agent other than the saved one. */
  panelTick: number;
  /** Panels that live frames named but this stack does not list yet (implicit panels); the stack must be refetched until they appear. */
  unknownPanels: string[];
  /**
   * Every waiting message the session has reported, also ones a batch of events added and removed before a render, so
   * a late reply to the request that queued a message never brings back the card of one the agent has since taken.
   */
  knownInputs: ReadonlySet<string>;
}
const withInputs = (known: ReadonlySet<string> | undefined, items: readonly { id: string }[]): ReadonlySet<string> =>
  known && items.every((item) => known.has(item.id)) ? known : new Set([...(known ?? []), ...items.map((item) => item.id)]);
export const isTerminal = (state: string) =>
  ["completed", "max_steps", "cancelled", "error", "interrupted"].includes(
    state,
  );
export function mergeHistory(
  a: HistoryView[],
  b: HistoryView[],
): HistoryView[] {
  return [
    ...new Map([...a, ...b].map((item) => [item.id, item])).values(),
  ].sort((x, y) => x.sequence - y.sequence);
}
/**
 * Adds a message the reply to `POST /inputs` says is waiting, unless the session already reported it. Applied as a state
 * update, after every event received before it, so a card the agent has since taken stays gone.
 */
export function addQueuedInput(state: ChatState | undefined, item: ChatState["inputs"][number]): ChatState | undefined {
  if (!state || state.knownInputs.has(item.id)) return state;
  return { ...state, inputs: [...state.inputs, item], knownInputs: new Set([...state.knownInputs, item.id]) };
}
export function reduceEvent(
  state: ChatState | undefined,
  event: DashboardEvent,
): ChatState | undefined {
  if (event.type === "snapshot" || event.type === "reset") {
    const olderLoaded =
      !!state?.history.items.length &&
      state.history.items[0]!.sequence <=
        (event.data.history.items[0]?.sequence ?? Infinity);
    const before = olderLoaded
      ? state!.history.nextCursor
      : event.data.history.nextCursor;
    return {
      ...event.data,
      history: {
        items: mergeHistory(
          state?.history.items ?? [],
          event.data.history.items,
        ),
        ...(before ? { nextCursor: before } : {}),
      },
      tools: {},
      views: {},
      compactions: {},
      snapshotCount: (state?.snapshotCount ?? 0) + 1,
      panelTick: state?.panelTick ?? 0,
      unknownPanels: [],
      knownInputs: withInputs(state?.knownInputs, event.data.inputs),
    };
  }
  if (!state) return state;
  switch (event.type) {
    case "commands":
      return { ...state, commands: event.data.items, commandsOmitted: event.data.omitted ?? 0 };
    case "inputs":
      return { ...state, inputs: event.data.items, knownInputs: withInputs(state.knownInputs, event.data.items) };
    case "history": {
      const ids = new Set(event.data.items.map((item) => item.id));
      const tools = { ...state.tools };
      const views = { ...state.views };
      const compactions = { ...state.compactions };
      for (const item of event.data.items) {
        if (item.panelReceipt?.view) delete views[item.panelReceipt.view.instanceId];
        if (item.callId && item.operationId)
          delete tools[`${item.operationId}:${item.callId}`];
        if (item.compaction?.status !== "running" && item.compaction)
          delete compactions[item.compaction.id];
      }
      return {
        ...state,
        history: {
          ...state.history,
          items: mergeHistory(state.history.items, event.data.items),
        },
        historyWatermark: event.data.historyWatermark,
        live: state.live.filter((item) => !ids.has(item.segmentId)),
        tools,
        views,
        compactions,
      };
    }
    case "text": {
      if (state.history.items.some((item) => item.id === event.data.segmentId))
        return state;
      const old = state.live.find(
        (item) => item.segmentId === event.data.segmentId,
      );
      const segment = {
        ...event.data,
        operationId: event.operationId!,
        text: old?.paged ? old.text : (old?.text ?? "") + event.data.text,
        paged: old?.paged ?? false,
      };
      // Large streams remain paged in the UI too. More can be loaded explicitly without growing every tab indefinitely.
      if (segment.text.length > 128 * 1024) {
        segment.text = segment.text.slice(0, 128 * 1024);
        segment.paged = true;
      }
      return {
        ...state,
        live: [
          ...state.live.filter((item) => item.segmentId !== segment.segmentId),
          segment,
        ],
      };
    }
    case "tool": {
      const key = `${event.operationId}:${event.data.callId}`;
      return {
        ...state,
        tools: {
          ...state.tools,
          [key]: {
            ...state.tools[key],
            ...event.data,
            operationId: event.operationId!,
          },
        },
      };
    }
    case "operation":
      return {
        ...state,
        operations: [
          event.data,
          ...state.operations.filter((op) => op.id !== event.data.id),
        ],
        ownership: isTerminal(event.data.state) ? "idle" : "here",
        ...(isTerminal(event.data.state)
          ? {
              live: state.live.filter(
                (segment) => segment.operationId !== event.data.id,
              ),
              tools: Object.fromEntries(
                Object.entries(state.tools).filter(
                  ([, tool]) => tool.operationId !== event.data.id,
                ),
              ),
              views: Object.fromEntries(Object.entries(state.views).filter(([, view]) => view.operationId !== event.data.id)),
            }
          : {}),
      };
    case "metrics":
      return { ...state, metrics: event.data, metricsStale: false };
    case "interaction":
      if ((state.interactions?.find(request => request.identity.requestId === event.data.identity.requestId)?.revision ?? 0) > event.data.revision) return state;
      return { ...state, interactions: state.interactions?.some(request => request.identity.requestId === event.data.identity.requestId)
        ? state.interactions.map(request => request.identity.requestId === event.data.identity.requestId ? event.data : request)
        : [...(state.interactions ?? []), event.data].slice(-50) };
    case "approval":
      return {
        ...state,
        approvals: [
          ...state.approvals.filter(
            (approval) => approval.id !== event.data.id,
          ),
          ...(event.data.status === "pending" ? [event.data] : []),
        ],
      };
    case "compaction":
      return event.data.details
        ? {
            ...state,
            compactions: {
              ...state.compactions,
              [event.data.details.id]: event.data,
            },
          }
        : state;
    case "ownership":
      return { ...state, ownership: event.data.ownership };
    case "panel": {
      if (event.data.view) {
        const id = event.data.view.instanceId;
        if (state.operations.some(operation => operation.id === event.operationId && isTerminal(operation.state))
          || state.history.items.some(item => item.panelReceipt?.view?.instanceId === id)
          || (state.views[id]?.revision ?? 0) > event.data.revision) return state;
        return { ...state, views: { ...state.views, [id]: { ...event.data, operationId: event.operationId! } } };
      }
      const applied = applyFrame(state.panels, event.data);
      return { ...state, panels: applied.items, panelTick: state.panelTick + 1,
        unknownPanels: applied.known || state.unknownPanels.includes(event.data.panel) ? state.unknownPanels : [...state.unknownPanels, event.data.panel].slice(-50) };
    }
    default:
      return state;
  }
}
/**
 * Last known state per session (in memory only). Reopening a chat renders this immediately
 * instead of a skeleton, and the stream's first snapshot then reconciles it (stale-while-revalidate).
 */
const remembered = new Map<string, ChatState>();
const REMEMBER_LIMIT = 20;
function remember(sessionId: string, state: ChatState): void {
  remembered.delete(sessionId);
  remembered.set(sessionId, state);
  if (remembered.size > REMEMBER_LIMIT)
    remembered.delete(remembered.keys().next().value!);
}
export function forgetSession(sessionId: string): void {
  remembered.delete(sessionId);
}
/** The titles the server gives a chat before its first message (src/sessions/store.ts setTitleFromPrompt). */
const placeholderTitle = (title: string | undefined): boolean => title === "New chat" || title === "New session";
export function useSession(sessionId: string | undefined, remote?: boolean) {
  const [state, setState] = useState<ChatState | undefined>(() =>
    sessionId ? remembered.get(sessionId) : undefined,
  );
  const [connection, setConnection] = useState("Connecting");
  const [error, setError] = useState("");
  const titleRef = useRef<string | undefined>(undefined);
  titleRef.current = state?.session.title;
  useEffect(() => {
    if (sessionId && state) remember(sessionId, state);
  }, [sessionId, state]);
  useEffect(() => {
    setState(sessionId ? remembered.get(sessionId) : undefined);
    setError("");
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | undefined;
    let lastSequence = -1;
    let epoch = "";
    // Stream events apply once per frame, as a transition, so a keystroke goes first (docs/chat-design.md §10).
    const batcher = createEventBatcher<DashboardEvent>((events, urgent) => {
      const update = (old: ChatState | undefined) => events.reduce(reduceEvent, old);
      if (urgent) setState(update);
      else startTransition(() => setState(update));
    }, browserScheduler);
    // Set only on a change: a same-value set while a batch is pending would still render the chat once per event.
    let connectionShown: string | undefined;
    let errorShown = "";
    const showConnection = (value: string) => {
      if (value !== connectionShown) setConnection((connectionShown = value));
    };
    const showError = (value: string) => {
      if (value !== errorShown) setError((errorShown = value));
    };
    const connect = async () => {
      showConnection("Connecting");
      try {
        await subscribe(
          sessionId,
          cursor,
          controller.signal,
          (event) => {
            const nextEpoch = event.id.slice(0, event.id.lastIndexOf(":"));
            if (
              event.type !== "reset" &&
              event.type !== "snapshot" &&
              nextEpoch === epoch &&
              event.sequence <= lastSequence
            )
              return;
            epoch = nextEpoch;
            lastSequence = event.sequence;
            cursor = event.id;
            showConnection("Connected");
            showError("");
            batcher.push(event);
            // A snapshot replaces what the queue would build on, so it applies at once, after the queued events.
            if (event.type === "snapshot" || event.type === "reset") batcher.flush(true);
            // The title is set from the first message when its turn starts, so a placeholder is refreshed at once; everything else at the end of the turn.
            if (event.type === "operation" && (isTerminal(event.data.state) || placeholderTitle(titleRef.current)))
              void api<SessionSnapshot>(
                `/sessions/${sessionId}`,
                "GET",
                undefined,
                controller.signal,
              )
                .then((snapshot) =>
                  setState((old) =>
                    old
                      ? {
                          ...old,
                          session: snapshot.session,
                          context: snapshot.context,
                          metrics: snapshot.metrics,
                          metricsStale: snapshot.metricsStale,
                          // A backend turn may have changed what the CLI lists (Claude's efforts follow the model).
                          ...(snapshot.backendOptions ? { backendOptions: snapshot.backendOptions } : {}),
                        }
                      : old,
                  ),
                )
                .catch(() => {});
            if (event.type === "host_error") showError(event.data.message);
          },
          () => {
            showConnection("Connected");
            showError("");
          },
          remote,
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        showConnection("Disconnected");
        showError(errorText(cause));
        if (!(cause instanceof ApiError && [401, 404].includes(cause.status)))
          timer = setTimeout(() => {
            void connect();
          }, 1500);
      }
    };
    void connect();
    return () => {
      controller.abort();
      batcher.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, remote]);
  /** Loads the previous history page. `beforeApply` runs once the page has arrived, right before it joins the state. */
  const earlier = async (beforeApply?: () => void) => {
    if (!state?.history.nextCursor || !sessionId) return;
    const page = await api<Page<HistoryView>>(
      `/sessions/${sessionId}/history?before=${encodeURIComponent(state.history.nextCursor)}&limit=50`,
    );
    beforeApply?.();
    setState((old) =>
      old
        ? {
            ...old,
            history: {
              ...page,
              items: mergeHistory(page.items, old.history.items),
            },
          }
        : old,
    );
  };
  const receipt = (operation: SessionOperation) =>
    setState((old) => {
      if (!old) return old;
      const current = old.operations.find((op) => op.id === operation.id);
      if (
        current &&
        (isTerminal(current.state) || current.updatedAt > operation.updatedAt)
      )
        return old;
      return {
        ...old,
        operations: [
          operation,
          ...old.operations.filter((op) => op.id !== operation.id),
        ],
        ownership: isTerminal(operation.state) ? "idle" : "here",
      };
    });
  return { state, setState, connection, error, earlier, receipt };
}
