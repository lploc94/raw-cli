import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Activity, CheckCircle2, CircleX, FileText, Flag, FolderTree, Gauge, ListChecks, ListOrdered, PanelTop, Table } from "lucide-react";
import type { PanelIcon } from "../../../src/panels/contract.js";
import type { PanelSummary } from "./summaries.js";

const icons: Record<PanelIcon, typeof Activity> = {
  "list-checks": ListChecks, "list-ordered": ListOrdered, "file-text": FileText, table: Table, activity: Activity, gauge: Gauge, "folder-tree": FolderTree, flag: Flag, panel: PanelTop,
};
export const PanelGlyph = ({ icon, size = 16 }: { icon: PanelIcon; size?: number }) => {
  const Icon = icons[icon] ?? PanelTop;
  return <Icon size={size} aria-hidden="true" />;
};
/** A done or failed document's glyph, with its meaning as hidden text. */
export const DocumentStatus = ({ status }: { status: "done" | "failed" }) => (
  <span className={`sp-doc-status ${status}`} title={status === "done" ? "Done" : "Failed"}>
    {status === "done" ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleX size={13} aria-hidden="true" />}
    <span className="sr-only">{status === "done" ? "Done" : "Failed"}</span>
  </span>
);

export interface TabSpec {
  id: string;
  title: string;
  icon: ReactNode;
  badge?: PanelSummary["badge"] | undefined;
  status?: "done" | "failed" | undefined;
  unseen?: boolean | undefined;
  /** Overview and Details stay in place. */
  movable: boolean;
  /** The document's explanation (its subtitle), in the tab's tooltip and description. */
  about?: string | undefined;
}

/**
 * The side panel's tab strip (WAI-ARIA tabs, manual activation): arrow keys, Home and End move focus, Enter or Space
 * selects. The selected tab shows its label; the others their icon and badge. A movable tab can be dragged along the strip.
 */
export function TabStrip({ tabs, active, panelId, idOf, onSelect, onDrop }: {
  tabs: readonly TabSpec[];
  active: string;
  /** The id of the tab panel the tabs control. */
  panelId: string;
  /** The DOM id of a tab, for `aria-labelledby` on the panel. */
  idOf: (tab: string) => string;
  onSelect: (tab: string) => void;
  onDrop: (tab: string, target: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(active);
  const [drag, setDrag] = useState<{ tab: string; over?: string | undefined }>();
  const suppressClick = useRef(false);
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  useEffect(() => setFocus(active), [active]);
  const focusable = tabs.some((tab) => tab.id === focus) ? focus : active;
  // Reveal the active or keyboard-focused tab inside the strip without scrolling the page. Details reserves its
  // pinned space, so a newly focused tab cannot disappear behind the context badge.
  useLayoutEffect(() => {
    const box = strip.current;
    const tab = box?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(focusable)}"]`);
    if (!box || !tab) return;
    const bounds = box.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    const details = box.querySelector<HTMLElement>('[data-tab="__details"]');
    const left = bounds.left + 3;
    const right = (details && details !== tab ? details.getBoundingClientRect().left : bounds.right) - 3;
    if (target.left < left) box.scrollLeft += target.left - left;
    else if (target.right > right) box.scrollLeft += target.right - right;
  }, [active, focusable, tabs.length]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === focusable);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = tabs[next]!.id;
    setFocus(id);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus();
  };
  const tabAt = (x: number): string | undefined => {
    let best: { id: string; distance: number } | undefined;
    strip.current?.querySelectorAll<HTMLElement>("[data-tab][data-movable]").forEach((element) => {
      const rect = element.getBoundingClientRect();
      const distance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      if (!best || distance < best.distance) best = { id: element.dataset.tab!, distance };
    });
    return best?.id;
  };
  // Movement and release are followed on the document from the moment the pointer goes down, so a fast drag that leaves
  // the tab still reorders, and a plain click (no movement) selects.
  const startDrag = (tab: TabSpec) => (event: PointerEvent<HTMLButtonElement>) => {
    if (!tab.movable || event.button !== 0) return;
    stopDrag.current?.();
    const start = { x: event.clientX, active: false };
    const moved = (next: globalThis.PointerEvent) => {
      if (!start.active && Math.abs(next.clientX - start.x) < 6) return;
      start.active = true;
      const over = tabAt(next.clientX);
      setDrag({ tab: tab.id, over: over !== tab.id ? over : undefined });
    };
    const up = (next: globalThis.PointerEvent) => {
      stopDrag.current?.();
      if (!start.active) return;
      setDrag(undefined);
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      const over = tabAt(next.clientX);
      if (over && over !== tab.id) onDrop(tab.id, over);
    };
    const cancel = () => { stopDrag.current?.(); setDrag(undefined); };
    document.addEventListener("pointermove", moved);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    stopDrag.current = () => {
      document.removeEventListener("pointermove", moved);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      stopDrag.current = undefined;
    };
  };
  return (
    <div className="sp-tabs" role="tablist" aria-label="Side panel tabs" ref={strip} onKeyDown={move}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        // The panel's explanation as a sentence, then its state: "Tracks the plan. 2 of 5 done, New update".
        const about = tab.about?.trim() ? (/[.!?…:]$/.test(tab.about.trim()) ? tab.about.trim() : `${tab.about.trim()}.`) : undefined;
        const facts = [tab.badge?.label, tab.status === "done" ? "Done" : tab.status === "failed" ? "Failed" : undefined, tab.unseen ? "New update" : undefined].filter(Boolean).join(", ");
        const describe = [about, facts].filter(Boolean).join(" ");
        const dragState = drag?.tab === tab.id ? "dragging" : drag?.over === tab.id ? "target" : "";
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={idOf(tab.id)}
            data-tab={tab.id}
            {...(tab.movable ? { "data-movable": "" } : {})}
            className={`sp-tab ${selected ? "active" : ""} ${dragState}`}
            aria-selected={selected}
            aria-controls={panelId}
            aria-label={tab.title}
            {...(describe ? { "aria-describedby": `${idOf(tab.id)}-about` } : {})}
            tabIndex={tab.id === focusable ? 0 : -1}
            title={describe ? `${tab.title} · ${describe}` : tab.title}
            onPointerDown={startDrag(tab)}
            onFocus={() => setFocus(tab.id)}
            onClick={() => { if (!suppressClick.current) onSelect(tab.id); }}
          >
            {tab.icon}
            {selected && <span className="sp-tab-label">{tab.title}</span>}
            {tab.status ? <DocumentStatus status={tab.status} /> : tab.badge && <span className={`sp-badge tone-${tab.badge.tone}`}>{tab.badge.text}</span>}
            {tab.unseen && <span className="sp-unseen" aria-hidden="true" />}
            {describe && <span id={`${idOf(tab.id)}-about`} hidden>{describe}</span>}
          </button>
        );
      })}
    </div>
  );
}
