/** Pure state for the dashboard side panel stack (docs/panels-design.md §13.1): ordering, hiding, expansion, sizes and what the browser remembers. */
import type { PanelDocument } from "../../../src/panels/contract.js";
import { derivedProgress } from "../../../src/panels/render.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";

export const DETAILS_ID = "__details";
export const storageKey = "raw.dashboard.panels.v1";
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 2000;
export const MAX_SESSIONS = 50;
export const MAX_IDS = 200;
const NO_AGENT = "_default";

/** What the browser remembers. Order, hidden set and height are per agent; expansion and seen revisions per session. */
export interface PanelPrefs {
  version: 1;
  order: Record<string, string[]>;
  hidden: Record<string, string[]>;
  heights: Record<string, number>;
  expanded: Record<string, string[]>;
  seen: Record<string, Record<string, number>>;
  /** Sessions in which "Follow the tool" already opened the side panel once. */
  opened: string[];
  /** The checklist "Hide completed" toggle, one choice per browser (§7.1). */
  hideCompleted: boolean;
}

export const emptyPrefs = (): PanelPrefs => ({ version: 1, order: {}, hidden: {}, heights: {}, expanded: {}, seen: {}, opened: [], hideCompleted: false });
export const agentKey = (agent: string | null | undefined): string => agent || NO_AGENT;

const ids = (value: unknown, allowDetails = false): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 512 && (allowDetails || entry !== DETAILS_ID)))].slice(0, MAX_IDS);
};
const record = <T>(value: unknown, convert: (entry: unknown) => T | undefined, max: number): Record<string, T> => {
  const out: Record<string, T> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(-max)) {
    const converted = convert(entry);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
};
const clampHeight = (value: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));

/** Corrupt or foreign storage never blocks: each field falls back to its default on its own. */
export function loadPrefs(storage: Pick<Storage, "getItem"> | undefined = globalStorage()): PanelPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(storageKey) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || raw.version !== 1) return emptyPrefs();
    return {
      version: 1,
      order: record(raw.order, (v) => (Array.isArray(v) ? ids(v) : undefined), MAX_SESSIONS),
      hidden: record(raw.hidden, (v) => (Array.isArray(v) ? ids(v) : undefined), MAX_SESSIONS),
      heights: record(raw.heights, (v) => (typeof v === "number" && Number.isFinite(v) ? clampHeight(v) : undefined), MAX_SESSIONS),
      expanded: record(raw.expanded, (v) => (Array.isArray(v) ? ids(v, true) : undefined), MAX_SESSIONS),
      seen: record(raw.seen, (v) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
        const out: Record<string, number> = {};
        for (const [key, revision] of Object.entries(v as Record<string, unknown>).slice(-MAX_IDS))
          if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) out[key] = revision;
        return out;
      }, MAX_SESSIONS),
      opened: ids(raw.opened).slice(-MAX_SESSIONS),
      hideCompleted: raw.hideCompleted === true,
    };
  } catch {
    return emptyPrefs();
  }
}
export function savePrefs(prefs: PanelPrefs, storage: Pick<Storage, "setItem"> | undefined = globalStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(prefs));
  } catch {
    // Storage may be full or blocked; the stack keeps working for this page load.
  }
}
function globalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Keeps the newest entries when a per-session or per-agent map grows past its bound. */
function bounded<T>(map: Record<string, T>, key: string, value: T, max = MAX_SESSIONS): Record<string, T> {
  const next = { ...map };
  delete next[key];
  next[key] = value;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - max))) delete next[old];
  return next;
}

/**
 * The stack order: the user's stored order restricted to panels that exist, with every other panel inserted by the rule of
 * §13.1. Walk backwards through the default order from the new panel and insert it right after the first predecessor
 * already placed; with none, insert at the top. Existing sections never change their relative order.
 */
export function arrange(defaultIds: readonly string[], stored: readonly string[]): string[] {
  const exists = new Set(defaultIds);
  const order = [...new Set(stored)].filter((id) => exists.has(id));
  const placed = new Set(order);
  defaultIds.forEach((id, index) => {
    if (placed.has(id)) return;
    let at = 0;
    for (let back = index - 1; back >= 0; back--) {
      const predecessor = order.indexOf(defaultIds[back]!);
      if (predecessor >= 0) { at = predecessor + 1; break; }
    }
    order.splice(at, 0, id);
    placed.add(id);
  });
  return order;
}

/** Move one section past its nearest visible neighbour. Returns the full new order (hidden sections keep their place). */
export function move(order: readonly string[], id: string, direction: "up" | "down", hidden: ReadonlySet<string>): string[] {
  const list = [...order];
  const from = list.indexOf(id);
  if (from < 0) return list;
  const step = direction === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < list.length && hidden.has(list[to]!)) to += step;
  if (to < 0 || to >= list.length) return list;
  list.splice(from, 1);
  list.splice(to, 0, id);
  return list;
}

/**
 * Drop `id` where `target` is: it takes the target's place, so dragging down lands after it and dragging up lands before it.
 * Hidden sections keep their positions relative to their neighbours because the move works on the full order.
 */
export function placeAt(order: readonly string[], id: string, target: string): string[] {
  const from = order.indexOf(id);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const list = [...order];
  list.splice(from, 1);
  list.splice(to, 0, id);
  return list;
}

export interface Arrangement { visible: PanelStackItem[]; hidden: PanelStackItem[] }
/** Splits the stack, in the user's order, into shown and hidden sections. */
export function layout(items: readonly PanelStackItem[], prefs: PanelPrefs, agent: string | null | undefined): Arrangement {
  const key = agentKey(agent);
  const byId = new Map(items.map((item) => [item.panel, item]));
  const order = arrange(items.map((item) => item.panel), prefs.order[key] ?? []);
  const hidden = new Set(prefs.hidden[key] ?? []);
  const all = order.map((id) => byId.get(id)!);
  return { visible: all.filter((item) => !hidden.has(item.panel)), hidden: all.filter((item) => hidden.has(item.panel)) };
}
/** The current full order for an agent, for persisting a move. */
export const currentOrder = (items: readonly PanelStackItem[], prefs: PanelPrefs, agent: string | null | undefined): string[] =>
  arrange(items.map((item) => item.panel), prefs.order[agentKey(agent)] ?? []);

export const setHideCompleted = (prefs: PanelPrefs, value: boolean): PanelPrefs => (prefs.hideCompleted === value ? prefs : { ...prefs, hideCompleted: value });
export const setOrder = (prefs: PanelPrefs, agent: string | null | undefined, order: string[]): PanelPrefs =>
  ({ ...prefs, order: bounded(prefs.order, agentKey(agent), order.slice(0, MAX_IDS)) });
export function setHidden(prefs: PanelPrefs, agent: string | null | undefined, panel: string, hide: boolean): PanelPrefs {
  const key = agentKey(agent);
  const rest = (prefs.hidden[key] ?? []).filter((id) => id !== panel);
  return { ...prefs, hidden: bounded(prefs.hidden, key, hide ? [...rest, panel].slice(-MAX_IDS) : rest) };
}
export const setHeight = (prefs: PanelPrefs, agent: string | null | undefined, height: number): PanelPrefs =>
  ({ ...prefs, heights: bounded(prefs.heights, agentKey(agent), clampHeight(height)) });
export const heightFor = (prefs: PanelPrefs, agent: string | null | undefined): number | undefined => prefs.heights[agentKey(agent)];
export function setExpanded(prefs: PanelPrefs, session: string, panel: string, open: boolean): PanelPrefs {
  const rest = (prefs.expanded[session] ?? []).filter((id) => id !== panel);
  return { ...prefs, expanded: bounded(prefs.expanded, session, open ? [...rest, panel] : rest) };
}
export const isExpanded = (prefs: PanelPrefs, session: string, panel: string): boolean => (prefs.expanded[session] ?? []).includes(panel);
export function markSeen(prefs: PanelPrefs, session: string, panel: string, revision: number): PanelPrefs {
  const current = prefs.seen[session] ?? {};
  if ((current[panel] ?? 0) >= revision) return prefs;
  return { ...prefs, seen: bounded(prefs.seen, session, { ...current, [panel]: revision }) };
}
/** Unseen when the revision is newer than the last one viewed here. A collapsed, hidden or closed section can be unseen. */
export const unseen = (prefs: PanelPrefs, session: string, item: Pick<PanelStackItem, "panel" | "revision">): boolean =>
  item.revision > 0 && item.revision > (prefs.seen[session]?.[item.panel] ?? 0);
export const hasOpened = (prefs: PanelPrefs, session: string): boolean => prefs.opened.includes(session);
export const markOpened = (prefs: PanelPrefs, session: string): PanelPrefs =>
  hasOpened(prefs, session) ? prefs : { ...prefs, opened: [...prefs.opened, session].slice(-MAX_SESSIONS) };

export interface PanelFrame { panel: string; revision: number; closed: boolean; document: PanelDocument }
/**
 * Applies one live `panel` frame. A frame whose revision is not greater than the one shown is ignored (snapshots are the
 * authority for anything lower). `known: false` means the panel is not in the stack yet (an implicit panel), so the caller refetches.
 */
export function applyFrame(items: readonly PanelStackItem[], frame: PanelFrame): { items: PanelStackItem[]; known: boolean } {
  const index = items.findIndex((item) => item.panel === frame.panel);
  if (index < 0) return { items: [...items], known: false };
  const current = items[index]!;
  if (frame.revision <= current.revision) return { items: [...items], known: true };
  const next = [...items];
  next[index] = { ...current, revision: frame.revision, closed: frame.closed, document: frame.document, updatedAt: Date.now() };
  return { items: next, known: true };
}

/**
 * The result of refetching the whole stack while live frames kept arriving: the response is a snapshot of an earlier moment,
 * so any panel that a live frame already advanced keeps its newer revision. `unresolved` are the ids that live frames
 * named but the response still does not list; they need another refetch.
 */
export function mergeStack(current: readonly PanelStackItem[], fetched: readonly PanelStackItem[], unknown: readonly string[]): { items: PanelStackItem[]; unresolved: string[] } {
  const byId = new Map(current.map((item) => [item.panel, item]));
  const items = fetched.map((item) => {
    const live = byId.get(item.panel);
    return live && live.revision > item.revision ? { ...item, revision: live.revision, closed: live.closed, document: live.document, updatedAt: live.updatedAt } : item;
  });
  const listed = new Set(items.map((item) => item.panel));
  return { items, unresolved: unknown.filter((id) => !listed.has(id)) };
}

export interface FirstOpenInput {
  /** Revisions shown before this update, by full id. */
  before: ReadonlyMap<string, number>;
  items: readonly PanelStackItem[];
  hidden: ReadonlySet<string>;
}
/** The first panel, in stack order, that declares `open: "first_update"`, just received its first revision and is not hidden. */
export function firstOpenTarget({ before, items, hidden }: FirstOpenInput): string | undefined {
  return items.find((item) => item.revision > 0 && (before.get(item.panel) ?? 0) === 0 && item.declaration.open === "first_update" && !hidden.has(item.panel))?.panel;
}

/** `"<title>: <done> of <total> done"`, or undefined when the panel reports no progress. */
export function announcement(item: Pick<PanelStackItem, "title" | "document">): string | undefined {
  const progress = item.document && derivedProgress(item.document);
  return progress ? `${item.title}: ${progress.done} of ${progress.total} done` : undefined;
}
/** True when at least 5 s passed since the last announcement of this panel. */
export const MIN_ANNOUNCE_MS = 5000;
export const mayAnnounce = (last: number | undefined, now: number): boolean => last === undefined || now - last >= MIN_ANNOUNCE_MS;

export interface AnnouncerState {
  /** The last text seen per panel; the first sighting only sets the baseline and is never spoken. */
  seen: Map<string, string>;
  /** Changed texts waiting for their panel's 5 s window. */
  queued: Map<string, string>;
  last: Map<string, number>;
}
export const newAnnouncer = (): AnnouncerState => ({ seen: new Map(), queued: new Map(), last: new Map() });
/**
 * Decides what the live region says now. Every panel with a changed text is spoken (several in one pass are joined, none is
 * dropped), at most once per 5 s each. A text that must wait stays queued; `wait` is when to call again (ms), if ever.
 */
export function planAnnouncements(state: AnnouncerState, items: readonly Pick<PanelStackItem, "panel" | "title" | "document">[], now: number): { say: string | undefined; wait: number | undefined } {
  for (const item of items) {
    const text = announcement(item);
    if (!text) continue;
    if (!state.seen.has(item.panel)) { state.seen.set(item.panel, text); continue; }
    if (state.seen.get(item.panel) === text) state.queued.delete(item.panel);
    else state.queued.set(item.panel, text);
  }
  const say: string[] = [];
  let wait: number | undefined;
  for (const [panel, text] of state.queued) {
    const last = state.last.get(panel);
    if (mayAnnounce(last, now)) {
      say.push(text);
      state.seen.set(panel, text);
      state.last.set(panel, now);
      state.queued.delete(panel);
    } else {
      const remaining = MIN_ANNOUNCE_MS - (now - last!);
      wait = wait === undefined ? remaining : Math.min(wait, remaining);
    }
  }
  return { say: say.length ? say.join(". ") : undefined, wait };
}

/** `10m`, `45s`, `1h 5m`: how long a step took (§7.2). */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
/** The elapsed time of a step, only when both timestamps exist (zero is a valid timestamp). */
export const stepDuration = (step: { started_at?: number; ended_at?: number }): string | undefined =>
  typeof step.started_at === "number" && typeof step.ended_at === "number" && step.ended_at >= step.started_at ? formatDuration(step.ended_at - step.started_at) : undefined;
/** `just now`, `5m ago`, `2h ago`, `3d ago` (§7.7). */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A receipt names its panel by the local id; the stack is keyed by the full id `<owner>#<panel>`. */
export const receiptPanel = (receipt: { panel: string; owner: string }): string => `${receipt.owner}#${receipt.panel}`;
/** The rejected-update code to show in a section: the newest receipt of that panel, when it was an error. */
export function rejectedCode(history: ReadonlyArray<{ panelReceipt?: { panel: string; owner: string; error?: { code: string } } }>, panel: string): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const receipt = history[index]!.panelReceipt;
    if (receipt && receiptPanel(receipt) === panel) return receipt.error?.code;
  }
  return undefined;
}
