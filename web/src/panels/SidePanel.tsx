import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type PointerEvent, type ReactNode, type SetStateAction } from "react";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import { offeredActions, type ActionHost } from "./actions.js";
import { ToolView } from "./ToolView.js";
import { Section, progressFor, statusTextFor, summaryFor } from "./Section.js";
import {
  DETAILS_ID, MIN_HEIGHT, currentOrder, heightFor, isExpanded, layout, markSeen, move, newAnnouncer, placeAt, planAnnouncements, rejectedCode, setExpanded, setHeight, setHidden,
  setHideCompleted, setOrder, unseen,
  type PanelPrefs,
} from "./panel-state.js";
import type { InsertRef } from "./status.js";

export interface SidePanelProps {
  sessionId: string;
  agent: string | null;
  items: PanelStackItem[];
  prefs: PanelPrefs;
  setPrefs: Dispatch<SetStateAction<PanelPrefs>>;
  history: ReadonlyArray<{ panelReceipt?: { panel: string; owner: string; error?: { code: string } } }>;
  onInsert: InsertRef;
  /** Runs panel actions; without it no action is offered. */
  actions?: ActionHost | undefined;
  /** A receipt click asks for this section to be shown; `nonce` makes repeated requests to the same panel distinct. */
  reveal: { panel: string; nonce: number } | undefined;
  /** The Details section content (the former inspector). */
  details: ReactNode;
}

/** The stack of sections shown in the side panel (docs/panels-design.md §13.1). */
export function SidePanelStack({ sessionId, agent, items, prefs, setPrefs, history, onInsert, actions, reveal, details }: SidePanelProps) {
  const box = useRef<HTMLDivElement>(null);
  const [boxHeight, setBoxHeight] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [announced, setAnnounced] = useState("");
  const announcer = useRef(newAnnouncer());
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [inView, setInView] = useState<ReadonlySet<string> | undefined>();
  const [drag, setDrag] = useState<{ panel: string; over?: string | undefined }>();
  const suppressClick = useRef(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    setBoxHeight(element.clientHeight);
    const observer = new ResizeObserver(() => setBoxHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const observing = typeof IntersectionObserver !== "undefined";
  const { visible, hidden } = layout(items, prefs, agent);
  const order = currentOrder(items, prefs, agent);
  const hiddenIds = new Set(hidden.map((item) => item.panel));
  // Fixed outer height: the user's choice for this agent, else half of the side panel. Content never changes it.
  const height = Math.max(MIN_HEIGHT, heightFor(prefs, agent) ?? Math.round(boxHeight * 0.5));
  const expandedOf = (panel: string) => isExpanded(prefs, sessionId, panel);
  const toggle = (panel: string) => setPrefs((old) => setExpanded(old, sessionId, panel, !isExpanded(old, sessionId, panel)));
  const resize = (next: number) => setPrefs((old) => setHeight(old, agent, next));
  // What someone can read counts as seen: an expanded section that is inside the stack's viewport, at its current revision.
  useEffect(() => {
    setPrefs((old) => {
      let next = old;
      for (const item of visible) if (expandedOf(item.panel) && (!observing || inView?.has(item.panel))) next = markSeen(next, sessionId, item.panel, item.revision);
      return next;
    });
  });
  // Reveal request from a receipt: scroll the section into view once it is rendered.
  useEffect(() => {
    if (!reveal) return;
    const element = box.current?.querySelector(`[data-panel="${CSS.escape(reveal.panel)}"]`);
    element?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [reveal?.nonce]);
  // Polite progress announcements: one pass speaks every changed panel, at most once per 5 s each; a text held back by
  // its window is delivered when the window ends.
  useEffect(() => {
    const run = () => {
      const { say, wait } = planAnnouncements(announcer.current, items, Date.now());
      if (say) setAnnounced(say);
      clearTimeout(announceTimer.current);
      if (wait !== undefined) announceTimer.current = setTimeout(run, wait + 20);
    };
    run();
    return () => clearTimeout(announceTimer.current);
  }, [items]);
  // Which expanded sections are actually inside the scrolling stack; unseen dots must not clear for content nobody can see.
  const expandedKey = visible.filter((item) => expandedOf(item.panel)).map((item) => item.panel).join("\0");
  useEffect(() => {
    const root = box.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const inside = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.panel!;
        if (entry.isIntersecting && entry.intersectionRect.height >= Math.min(120, entry.boundingClientRect.height * 0.5)) inside.add(id);
        else inside.delete(id);
      }
      setInView(new Set(inside));
    }, { root, threshold: [0, 0.25, 0.5, 1] });
    root.querySelectorAll("[data-panel]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [expandedKey, height]);
  const sectionAt = (y: number): string | undefined => {
    let best: { id: string; distance: number } | undefined;
    box.current?.querySelectorAll<HTMLElement>("[data-panel]").forEach((element) => {
      const id = element.dataset.panel!;
      if (id === DETAILS_ID) return;
      const rect = element.getBoundingClientRect();
      const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (!best || distance < best.distance) best = { id, distance };
    });
    return best?.id;
  };
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  const dragFor = (item: PanelStackItem) => ({
    // Movement and release are followed on the document from the moment the pointer goes down, so a fast drag that leaves
    // the source header still reorders, and a plain click (no movement) is left alone.
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as Element).closest(".panel-menu")) return;
      stopDrag.current?.();
      const start = { y: event.clientY, active: false };
      const move = (next: globalThis.PointerEvent) => {
        if (!start.active && Math.abs(next.clientY - start.y) < 6) return;
        start.active = true;
        const over = sectionAt(next.clientY);
        setDrag({ panel: item.panel, over: over !== item.panel ? over : undefined });
      };
      const finish = (next: globalThis.PointerEvent | undefined) => {
        stopDrag.current?.();
        if (!start.active) return;
        setDrag(undefined);
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const over = next && sectionAt(next.clientY);
        if (over && over !== item.panel) setPrefs((old) => setOrder(old, agent, placeAt(currentOrder(items, old, agent), item.panel, over)));
      };
      const up = (next: globalThis.PointerEvent) => finish(next);
      const cancel = () => { stopDrag.current?.(); setDrag(undefined); };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancel);
      stopDrag.current = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", cancel);
        stopDrag.current = undefined;
      };
    },
    state: drag?.panel === item.panel ? ("dragging" as const) : drag?.over === item.panel ? ("target" as const) : undefined,
  });
  const menuFor = (item: PanelStackItem) => {
    const index = order.indexOf(item.panel);
    const shown = order.filter((id) => !hiddenIds.has(id));
    const at = shown.indexOf(item.panel);
    const reorder = (direction: "up" | "down") => setPrefs((old) => setOrder(old, agent, move(currentOrder(items, old, agent), item.panel, direction, new Set(layout(items, old, agent).hidden.map((entry) => entry.panel)))));
    const own = actions ? offeredActions(item, actions, "panel").map((entry) => ({ id: entry.action.id, label: entry.action.label, disabled: entry.disabled, run: entry.run })) : [];
    return {
      actions: own,
      up: index > 0 && at > 0 ? () => reorder("up") : undefined,
      down: at >= 0 && at < shown.length - 1 ? () => reorder("down") : undefined,
      hide: () => setPrefs((old) => setHidden(old, agent, item.panel, true)),
    };
  };
  return (
    <div className="panel-stack" ref={box}>
      {visible.map((item) => {
        const rejected = rejectedCode(history, item.panel);
        const progress = progressFor(item);
        return (
          <Section
            key={item.panel}
            panel={item.panel}
            title={item.title}
            icon={item.icon}
            summary={summaryFor(item)}
            progress={progress}
            statusText={statusTextFor(item)}
            unseen={unseen(prefs, sessionId, item)}
            muted={!item.document}
            expanded={expandedOf(item.panel)}
            height={height}
            onToggle={() => { if (!suppressClick.current) toggle(item.panel); }}
            onResize={resize}
            drag={dragFor(item)}
            menu={menuFor(item)}
          >
            <ToolView item={item} actions={actions} onInsert={onInsert} hideCompleted={prefs.hideCompleted} onHideCompleted={(value) => setPrefs((old) => setHideCompleted(old, value))}>
            {rejected && <p className="panel-banner error" role="note">Update rejected: {rejected}</p>}
            </ToolView>
          </Section>
        );
      })}
      {hidden.length > 0 && (
        <div className="panel-hidden">
          <button type="button" className="panel-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((value) => !value)}>
            {hidden.length} hidden {hidden.length === 1 ? "section" : "sections"}
          </button>
          {showHidden && (
            <ul>
              {hidden.map((item) => (
                <li key={item.panel}>
                  <button type="button" onClick={() => setPrefs((old) => setHidden(old, agent, item.panel, false))}>Show {item.title}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Section
        panel={DETAILS_ID}
        title="Details"
        expanded={expandedOf(DETAILS_ID)}
        height={height}
        onToggle={() => toggle(DETAILS_ID)}
        onResize={resize}
      >
        {details}
      </Section>
      <span className="sr-only" role="status" aria-live="polite">{announced}</span>
    </div>
  );
}
