import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import { api } from "../api.js";
import type { ChatState } from "../session.js";
import { firstOpenTarget, mergeStack, hasOpened, layout, loadPrefs, markOpened, savePrefs, setExpanded, setHidden, type PanelPrefs } from "./panel-state.js";

interface Response { agent: string | null; items: PanelStackItem[] }
const NONE: PanelStackItem[] = [];
const NONE_IDS: string[] = [];

/**
 * The stack for the agent shown in this view. For the session's saved agent the stream's snapshot (kept current by live
 * frames) is the source. For any other agent the stack is refetched from `GET /panels?agent=`: on every agent change,
 * every snapshot or reset (so a stream resume refreshes it too) and after live frames. Failures leave the last stack visible.
 */
export function usePanelStack(opts: {
  sessionId: string;
  state: ChatState | undefined;
  setState: Dispatch<SetStateAction<ChatState | undefined>>;
  agent: string;
  narrow: boolean;
  panelOpen: "follow" | "never";
  openSide: () => void;
  /** Opens the side panel for an update the user did not ask for: focus must stay where it is. */
  autoOpen: () => void;
}) {
  const { sessionId, state, setState, agent, narrow, panelOpen, openSide, autoOpen } = opts;
  const [prefs, setPrefs] = useState<PanelPrefs>(loadPrefs);
  useEffect(() => savePrefs(prefs), [prefs]);
  const saved = state?.agent ?? null;
  const foreign = !!state && !!agent && agent !== saved;
  const [other, setOther] = useState<{ sessionId: string; agent: string; items: PanelStackItem[] }>();
  useEffect(() => {
    if (!foreign) return;
    let live = true;
    void api<Response>(`/sessions/${sessionId}/panels?agent=${encodeURIComponent(agent)}`)
      .then((result) => { if (live) setOther({ sessionId, agent, items: result.items }); })
      .catch(() => {});
    return () => { live = false; };
  }, [foreign, sessionId, agent, state?.snapshotCount, state?.panelTick]);
  // An implicit panel published its first update: the saved agent's stack is refetched to learn its declaration. The response
  // is older than the frames received meanwhile, so it is merged, never assigned; a failed request retries on the next frame.
  const unknown = state?.unknownPanels ?? NONE_IDS;
  useEffect(() => {
    if (!unknown.length) return;
    let live = true;
    void api<Response>(`/sessions/${sessionId}/panels`)
      .then((result) => {
        if (!live) return;
        setState((old) => {
          if (!old) return old;
          const merged = mergeStack(old.panels, result.items, old.unknownPanels);
          return { ...old, panels: merged.items, unknownPanels: merged.unresolved };
        });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [unknown.length > 0, sessionId, setState, state?.panelTick]);
  const fetched = foreign && other?.sessionId === sessionId && other.agent === agent ? other.items : undefined;
  const livePanels = state?.panels;
  // Another agent's stack comes from the server, but a panel's content is the session's: newer streamed revisions win.
  const items = useMemo(() => (foreign ? (fetched && livePanels ? mergeStack(livePanels, fetched, []).items : NONE) : (livePanels ?? NONE)), [foreign, fetched, livePanels]);
  const stackAgent = agent || saved;

  // First update of a `first_update` panel opens the side panel once per session, without moving focus.
  const [reveal, setReveal] = useState<{ panel: string; nonce: number }>();
  const previous = useRef<{ key: string; map: Map<string, number> } | undefined>(undefined);
  useEffect(() => {
    // A stack for another agent that has not loaded yet is not a state to compare against.
    if (!state || (foreign && items === NONE)) return;
    const key = `${sessionId}\0${stackAgent}\0${state.snapshotCount}\0${foreign}`;
    const map = new Map(items.map((item) => [item.panel, item.revision]));
    const before = previous.current;
    previous.current = { key, map };
    // A snapshot, a session change or an agent switch only re-bases what was shown; it never opens anything.
    if (!before || before.key !== key) return;
    if (narrow || panelOpen === "never" || hasOpened(prefs, sessionId)) return;
    const hidden = new Set(layout(items, prefs, stackAgent).hidden.map((item) => item.panel));
    const target = firstOpenTarget({ before: before.map, items, hidden });
    if (!target) return;
    setPrefs((old) => {
      const marked = markOpened(old, sessionId);
      return (old.expanded[sessionId] ?? []).length === 0 ? setExpanded(marked, sessionId, target, true) : marked;
    });
    autoOpen();
    setReveal((old) => ({ panel: target, nonce: (old?.nonce ?? 0) + 1 }));
  }, [items]);

  const show = useCallback((panel: string) => {
    setPrefs((old) => setExpanded(setHidden(old, stackAgent, panel, false), sessionId, panel, true));
    openSide();
    setReveal((old) => ({ panel, nonce: (old?.nonce ?? 0) + 1 }));
  }, [sessionId, stackAgent, openSide]);
  return { items, prefs, setPrefs, stackAgent, reveal, show };
}
