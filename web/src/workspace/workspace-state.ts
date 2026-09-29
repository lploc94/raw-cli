/** Pure state for the workspace switcher: what the browser remembers (pins, removed entries, opened folders) and how the list is arranged. */
export interface WorkspaceItem {
  cwd: string;
  updatedAt: number;
  sessions: number;
  running: number;
  exists: boolean;
}
export interface WorkspaceState {
  version: 1;
  pinned: string[];
  hidden: string[];
  opened: Array<{ path: string; at: number }>;
}
export interface WorkspaceRow extends WorkspaceItem {
  pinned: boolean;
  /** The later of the server's last use and the time this browser opened it. */
  rank: number;
}
export interface Arranged {
  current: WorkspaceRow;
  pinned: WorkspaceRow[];
  recent: WorkspaceRow[];
}

export const storageKey = "raw.dashboard.workspaces.v1";
export const MAX_PINNED = 50;
export const MAX_HIDDEN = 200;
export const MAX_OPENED = 50;
export const INCLUDE_BATCH = 50;

export function emptyState(): WorkspaceState {
  return { version: 1, pinned: [], hidden: [], opened: [] };
}

/** What the server accepts for one `include` path. Storage keeps everything that passes, so a preference is never lost on reload. */
const storable = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0");
export const MAX_QUERY_CHARS = 6000;
/** Longest encoded `include` parameter one request can carry within the server's 16 KB header limit. */
export const MAX_ENCODED_PATH = 12000;
/** A stored path a request can describe. Others (a lone surrogate, an enormous multibyte path) stay remembered but are never sent, so they cannot fail the list for everyone else. */
export function requestable(path: string): boolean {
  try {
    return `include=${encodeURIComponent(path)}&`.length <= MAX_ENCODED_PATH;
  } catch {
    return false;
  }
}
const MAX_TIME = 8.64e15;

const paths = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) if (storable(entry)) seen.add(entry);
  return [...seen].slice(-max);
};

export function loadState(storage: Pick<Storage, "getItem"> | undefined = globalStorage()): WorkspaceState {
  try {
    const raw = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (!raw || raw.version !== 1) return emptyState();
    const opened = new Map<string, number>();
    if (Array.isArray(raw.opened))
      for (const entry of raw.opened)
        if (entry && storable(entry.path) && typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at >= 0 && entry.at <= MAX_TIME)
          opened.set(entry.path, entry.at);
    return {
      version: 1,
      pinned: paths(raw.pinned, MAX_PINNED),
      hidden: paths(raw.hidden, MAX_HIDDEN),
      opened: [...opened].map(([path, at]) => ({ path, at })).slice(-MAX_OPENED),
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: WorkspaceState, storage: Pick<Storage, "setItem"> | undefined = globalStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* Storage can be full or blocked; the choice then lasts only for this page. */
  }
}

function globalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const without = (list: string[], path: string) => list.filter((entry) => entry !== path);

export function togglePin(state: WorkspaceState, path: string): WorkspaceState {
  if (state.pinned.includes(path)) return { ...state, pinned: without(state.pinned, path) };
  return { ...state, pinned: [...state.pinned, path].slice(-MAX_PINNED) };
}

/** Removes a workspace from Recent in this browser only. */
export function hide(state: WorkspaceState, path: string): WorkspaceState {
  return { ...state, hidden: [...without(state.hidden, path), path].slice(-MAX_HIDDEN), opened: state.opened.filter((entry) => entry.path !== path) };
}

export function unhide(state: WorkspaceState, path: string): WorkspaceState {
  return { ...state, hidden: without(state.hidden, path) };
}

/** A workspace was successfully opened: it becomes Recent again and leads it until something newer is used. */
export function recordOpened(state: WorkspaceState, path: string, now: number): WorkspaceState {
  const opened = [...state.opened.filter((entry) => entry.path !== path), { path, at: now }].slice(-MAX_OPENED);
  return { ...unhide(state, path), opened };
}

/** Paths the server did not necessarily list but the switcher still has to describe. */
export function includePaths(state: WorkspaceState): string[] {
  return [...new Set([...state.pinned, ...state.opened.map((entry) => entry.path)])].filter(requestable);
}

export function batches<T>(values: readonly T[], size = INCLUDE_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/** Batches of at most 50 paths whose encoded `include` parameters also stay under a URL length budget (a lone path is never split, and every stored path fits one request on its own). */
export function batchPaths(values: readonly string[], size = INCLUDE_BATCH, budget = MAX_QUERY_CHARS): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const path of values) {
    const cost = `include=${encodeURIComponent(path)}&`.length;
    if (current.length && (current.length >= size || used + cost > budget)) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(path);
    used += cost;
  }
  if (current.length) out.push(current);
  return out;
}

/** Merges several list responses by path, keeping the entry that knows the most. */
export function mergeItems(lists: readonly (readonly WorkspaceItem[])[]): WorkspaceItem[] {
  const merged = new Map<string, WorkspaceItem>();
  for (const list of lists)
    for (const item of list) {
      const old = merged.get(item.cwd);
      if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt && item.sessions > old.sessions)) merged.set(item.cwd, item);
    }
  return [...merged.values()];
}

const unknown = (cwd: string): WorkspaceItem => ({ cwd, updatedAt: 0, sessions: 0, running: 0, exists: true });

export function arrange(items: readonly WorkspaceItem[], state: WorkspaceState, current: string): Arranged {
  const byPath = new Map(items.map((item) => [item.cwd, item]));
  const openedAt = new Map(state.opened.map((entry) => [entry.path, entry.at]));
  const row = (cwd: string): WorkspaceRow => {
    const item = byPath.get(cwd) ?? unknown(cwd);
    return { ...item, pinned: state.pinned.includes(cwd), rank: Math.max(item.updatedAt, openedAt.get(cwd) ?? 0) };
  };
  const currentRow = row(current);
  const pinned = state.pinned.filter((path) => path !== current).map(row);
  const hidden = new Set(state.hidden);
  const candidates = new Set([...items.map((item) => item.cwd), ...openedAt.keys()]);
  const recent = [...candidates]
    .filter((path) => path !== current && !state.pinned.includes(path) && !hidden.has(path))
    .map(row)
    .sort((a, b) => b.rank - a.rank || a.cwd.localeCompare(b.cwd));
  return { current: currentRow, pinned, recent };
}

export function baseName(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
}

export function shortenPath(path: string, home: string): string {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const root = home.length > 1 ? home.replace(/\/+$/, "") : home;
  if (!root) return clean;
  if (clean === root) return "~";
  return clean.startsWith(`${root}/`) ? `~${clean.slice(root.length)}` : clean;
}

/** The shortened path, with the middle elided when it is long, so the ends (root and folder name) stay visible. The full path belongs in a tooltip. */
export function displayPath(path: string, home: string, max = 40): string {
  const short = shortenPath(path, home);
  if (short.length <= max) return short;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${short.slice(0, max - 1 - tail)}…${short.slice(short.length - tail)}`;
}

export function relativeTime(at: number, now: number): string {
  if (!at) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function chatsLabel(count: number): string {
  return count === 1 ? "1 chat" : `${count} chats`;
}

/** Substring matches (name or path) come first, then in-order character matches; other rows are dropped. */
export function filterRows<T extends { cwd: string }>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  const direct: T[] = [];
  const fuzzy: T[] = [];
  for (const row of rows) {
    const haystack = row.cwd.toLowerCase();
    if (haystack.includes(needle)) direct.push(row);
    else {
      let at = 0;
      let ok = true;
      for (const ch of needle) {
        at = haystack.indexOf(ch, at);
        if (at < 0) {
          ok = false;
          break;
        }
        at++;
      }
      if (ok) fuzzy.push(row);
    }
  }
  return [...direct, ...fuzzy];
}
