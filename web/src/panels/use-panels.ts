import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import { COMMANDS_ID, commandsSection } from "./commands-state.js";
import { APPROVALS_ID, approvalsSection } from "./approvals-state.js";
import { api } from "../api.js";
import type { ChatState } from "../session.js";
import { OVERVIEW_ID, activeTab, firstOpenTarget, mergeStack, hasOpened, layout, loadPrefs, markOpened, savePrefs, setHidden, setTab, type PanelPrefs } from "./panel-state.js";

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
  const toolItems = useMemo(() => (foreign ? (fetched && livePanels ? mergeStack(livePanels, fetched, []).items : NONE) : (livePanels ?? NONE)), [foreign, fetched, livePanels]);
  // The host's own tabs come last: Commands while any command is listed, Approvals while any call waits for permission.
  const items = useMemo(() => {
    const withCommands = state?.commands?.length ? [...toolItems, commandsSection(state.commands)] : toolItems;
    return state?.approvals.length ? [...withCommands, approvalsSection(state.approvals)] : withCommands;
  }, [toolItems, state?.commands, state?.approvals]);
  const stackAgent = agent || saved;

  /**
   * Opening by itself (Follow the tool) happens once per session and never moves focus. It selects the panel's tab only
   * while Overview is showing, so it never takes the user away from a tab they chose.
   */
  const follow = (old: PanelPrefs, panel: string): PanelPrefs => {
    const marked = markOpened(old, sessionId);
    return activeTab(old, sessionId, layout(items, old, stackAgent).visible.map((item) => item.panel)) === OVERVIEW_ID ? setTab(marked, sessionId, panel) : marked;
  };
  // First update of a `first_update` panel opens the side panel once per session, without moving focus.
  const previous = useRef<{ key: string; map: Map<string, number> } | undefined>(undefined);
  useEffect(() => {
    // A stack for another agent that has not loaded yet is not a state to compare against.
    if (!state || (foreign && toolItems === NONE)) return;
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
    setPrefs((old) => follow(old, target));
    autoOpen();
  }, [items]);

  const backgroundBefore = useRef<{ key: string; ids: Set<string> } | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const key = `${sessionId}\0${state.snapshotCount}`;
    const ids = new Set((state.commands ?? []).filter(item => item.kind === "background").map(item => item.id));
    const before = backgroundBefore.current;
    backgroundBefore.current = { key, ids };
    if (!before || before.key !== key || ![...ids].some(id => !before.ids.has(id))) return;
    if (narrow || panelOpen === "never" || hasOpened(prefs, sessionId) || layout(items, prefs, stackAgent).hidden.some(item => item.panel === COMMANDS_ID)) return;
    setPrefs(old => follow(old, COMMANDS_ID));
    autoOpen();
  }, [state?.commands, state?.snapshotCount, sessionId]);

  /** A receipt click: open the side panel, unhide the panel's tab and select it. */
  const show = useCallback((panel: string) => {
    setPrefs((old) => setTab(setHidden(old, stackAgent, panel, false), sessionId, panel));
    openSide();
  }, [sessionId, stackAgent, openSide]);
  return { items, prefs, setPrefs, stackAgent, show };
}
