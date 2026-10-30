import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
export const COMMANDS_ID = "__commands";
export const commandRunning = (item: CommandRecord) => ["starting", "running", "stopping"].includes(item.state);
/** A local layout descriptor only: never submitted to PanelHost or exposed as tool authority. */
export function commandsSection(commands: readonly CommandRecord[]): PanelStackItem {
  const revision = commands.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  return { panel: COMMANDS_ID, owner: "", title: "Commands", icon: "activity", revision, updatedAt: revision || null, closed: false, stale: false,
    declaration: { id: COMMANDS_ID, title: "Commands", icon: "activity", open: "never", context: "none", acp_plan: false, actions: [] },
    document: commands.length ? { blocks: [], summary: `${commands.filter(commandRunning).length} running · ${commands.length} total` } : null };
}
/** Strip OSC (including hyperlinks), CSI and remaining terminal controls; never interpret terminal markup as HTML. */
export function terminalText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** A failure, a timeout or a lost job: neither running, stopped nor a zero exit. */
export const commandFailed = (item: CommandRecord): boolean =>
  !commandRunning(item) && item.state !== "stopped" && !(item.state === "exited" && !item.exitCode);

/** A command card's state (docs/side-panel-design.md §4): the chip word, never colour alone, and the card's tone. */
export type CommandTone = "running" | "failed" | "success" | "warning" | "muted";
export interface CommandStatus { tone: CommandTone; chip: string; label: string; compact: boolean }
export function commandStatus(item: CommandRecord): CommandStatus {
  if (commandRunning(item)) {
    const word = item.state === "stopping" ? "Stopping" : item.state === "starting" ? "Starting" : item.paused ? "Paused" : "Running";
    return { tone: "running", chip: word, label: word, compact: false };
  }
  // Timed out, stopped and lost are compact cards with their own chip; only a failure shows the whole card.
  if (item.state === "timed_out") return { tone: "warning", chip: "Timed out", label: "Timed out", compact: true };
  if (item.state === "lost") return { tone: "warning", chip: "Lost", label: "Lost", compact: true };
  if (item.state === "stopped") return { tone: "muted", chip: "Stopped", label: "Stopped", compact: true };
  if (item.state === "exited" && !item.exitCode) return { tone: "success", chip: "Done", label: "Succeeded", compact: true };
  const chip = item.exitCode ? `Exit ${item.exitCode}` : item.signal ?? "Failed";
  return { tone: "failed", chip, label: item.exitCode ? `Failed with exit ${item.exitCode}` : `Failed${item.signal ? ` (${item.signal})` : ""}`, compact: false };
}

/** The status filter of the Commands tab (docs/side-panel-design.md §4). */
export type CommandFilter = "all" | "running" | "failed";
export const COMMAND_FILTERS: readonly CommandFilter[] = ["all", "running", "failed"];
export const commandMatches = (item: CommandRecord, filter: CommandFilter): boolean =>
  filter === "all" || (filter === "running" ? commandRunning(item) : commandFailed(item));
export const commandsStorageKey = "raw.dashboard.commands.v1";
/** Sessions whose filter is kept; the least recently changed are dropped first. */
export const MAX_COMMAND_SESSIONS = 200;
export interface CommandFilterPrefs { version: 1; sessions: Record<string, { filter: CommandFilter; at: number }> }

const storage = (): Storage | undefined => {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
};
/** Corrupt or foreign storage, and the group choices of earlier versions, fall back to All, entry by entry. */
export function loadCommandFilters(from: Pick<Storage, "getItem"> | undefined = storage()): CommandFilterPrefs {
  const prefs: CommandFilterPrefs = { version: 1, sessions: {} };
  try {
    const raw = JSON.parse(from?.getItem(commandsStorageKey) ?? "null") as { version?: unknown; sessions?: unknown } | null;
    if (raw?.version !== 1 || !raw.sessions || typeof raw.sessions !== "object") return prefs;
    for (const [id, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
      const entry = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
      if (!entry || !COMMAND_FILTERS.includes(entry.filter as CommandFilter)) continue;
      prefs.sessions[id] = { filter: entry.filter as CommandFilter, at: typeof entry.at === "number" ? entry.at : 0 };
    }
  } catch { /* the defaults */ }
  return prefs;
}
export function saveCommandFilters(prefs: CommandFilterPrefs, to: Pick<Storage, "setItem"> | undefined = storage()): void {
  try { to?.setItem(commandsStorageKey, JSON.stringify(prefs)); } catch { /* storage full or disabled: the choice lasts this page */ }
}
export const commandFilterOf = (prefs: CommandFilterPrefs, sessionId: string): CommandFilter => prefs.sessions[sessionId]?.filter ?? "all";
export function setCommandFilter(prefs: CommandFilterPrefs, sessionId: string, filter: CommandFilter, now = Date.now()): CommandFilterPrefs {
  const sessions = { ...prefs.sessions, [sessionId]: { filter, at: now } };
  const kept = Object.entries(sessions).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_COMMAND_SESSIONS);
  return { version: 1, sessions: Object.fromEntries(kept) };
}

/**
 * The page's filter choices, outside the tab body: switching tabs unmounts it, and storage may be full or disabled, so
 * the choices live here first and are saved best-effort. A change starts from storage, so choices another tab made for
 * other sessions are kept, and this page's choices win.
 */
export function commandFilterStore(from: () => Pick<Storage, "getItem" | "setItem"> | undefined = storage) {
  let memory: CommandFilterPrefs | undefined;
  return {
    get: (): CommandFilterPrefs => (memory ??= loadCommandFilters(from())),
    set(sessionId: string, filter: CommandFilter, now = Date.now()): CommandFilterPrefs {
      const stored = loadCommandFilters(from());
      memory = setCommandFilter({ version: 1, sessions: { ...stored.sessions, ...memory?.sessions } }, sessionId, filter, now);
      saveCommandFilters(memory, from());
      return memory;
    },
  };
}
export const commandFilters = commandFilterStore();
