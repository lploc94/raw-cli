import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SessionStore } from "../sessions/store.js";
import { DashboardError } from "./errors.js";

const MAX_INCLUDE = 50;
const MAX_PATH = 4096;
const MAX_QUERY = 200;
export const MAX_BROWSE_ENTRIES = 500;
const STAT_CONCURRENCY = 16;

export interface WorkspaceItem { cwd: string; updatedAt: number; sessions: number; running: number; exists: boolean }
export interface WorkspaceListing { items: WorkspaceItem[]; home: string; current: string }
export interface BrowseEntry { name: string; path: string; symlink?: true }
export interface BrowseListing { path: string; parent: string | null; home: string; entries: BrowseEntry[]; truncated: boolean }

export function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Expands a leading `~` to the home directory; other values are returned unchanged. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") || value.startsWith("~\\") ? join(home, value.slice(2)) : value;
}

/** Maps with a fixed number of concurrent calls, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!); }
  }));
  return results;
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function includePaths(search: URLSearchParams, home: string): string[] {
  const values = search.getAll("include");
  if (values.length > MAX_INCLUDE) throw new DashboardError(400, "invalid_input", `include accepts at most ${MAX_INCLUDE} paths`);
  for (const value of values)
    if (!value.trim() || value.length > MAX_PATH || value.includes("\0")) throw new DashboardError(400, "invalid_input", `include must be a non-empty path of at most ${MAX_PATH} characters`);
  return [...new Set(values.map((value) => expandHome(value, home)))];
}

export async function listWorkspaces(store: SessionStore, options: { current: string; env: NodeJS.ProcessEnv; search: URLSearchParams; running: () => Map<string, number> }): Promise<WorkspaceListing> {
  const home = homeDirectory(options.env);
  const extra = includePaths(options.search, home);
  const running = options.running();
  const activity = store.recentWorkspaces();
  const known = new Set(activity.map((item) => item.cwd));
  const wanted: Array<{ cwd: string; updatedAt: number; sessions: number }> = [...activity];
  const add = (item: { cwd: string; updatedAt: number; sessions: number }) => { if (!known.has(item.cwd)) { known.add(item.cwd); wanted.push(item); } };
  const current = activity.find((item) => item.cwd === options.current);
  if (!current) {
    const own = store.workspaceActivity([options.current])[0];
    wanted.unshift(own ?? { cwd: options.current, updatedAt: 0, sessions: 0 }); known.add(options.current);
  }
  for (const path of extra) {
    const canonical = await realpath(resolve(path)).catch(() => undefined);
    const stored = canonical === undefined ? undefined : store.workspaceActivity([canonical])[0];
    if (stored) add(stored); else add({ cwd: canonical ?? resolve(path), updatedAt: 0, sessions: 0 });
  }
  const items = await mapLimit(wanted, STAT_CONCURRENCY, async (item) => ({ ...item, running: running.get(item.cwd) ?? 0, exists: await isDirectory(item.cwd) }));
  return { items, home, current: options.current };
}

function flag(value: string | null, name: string): boolean {
  if (value === null || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new DashboardError(400, "invalid_input", `${name} must be 0, 1, true or false`);
}

/** Read-only, directories-only listing of one directory. Never reports files, sizes or times. */
export async function browseDirectory(search: URLSearchParams, env: NodeJS.ProcessEnv): Promise<BrowseListing> {
  const home = homeDirectory(env);
  const hidden = flag(search.get("hidden"), "hidden");
  const query = (search.get("q") ?? "").toLowerCase();
  if (query.length > MAX_QUERY) throw new DashboardError(400, "invalid_input", `q must be at most ${MAX_QUERY} characters`);
  const raw = search.get("path");
  if (raw !== null && (raw.length > MAX_PATH || raw.includes("\0"))) throw new DashboardError(400, "invalid_workspace", "Choose an existing directory");
  const requested = raw === null || raw === "" ? home : expandHome(raw, home);
  const invalid = () => new DashboardError(400, "invalid_workspace", "Choose an existing directory");
  if (!isAbsolute(requested)) throw invalid();
  let path: string;
  const unreadable = () => new DashboardError(422, "unreadable_directory", "This directory cannot be read");
  try { path = await realpath(requested); if (!(await stat(path)).isDirectory()) throw invalid(); }
  catch (error) { throw error instanceof DashboardError ? error : permissionDenied(error) ? unreadable() : invalid(); }
  let names;
  try { names = await readdir(path, { withFileTypes: true }); }
  catch (error) { throw permissionDenied(error) ? unreadable() : invalid(); }
  const candidates = names
    .filter((entry) => (hidden || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(query) && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Directories are confirmed before they count towards the cap, so `truncated` means a 501st directory really matched.
  const entries: BrowseEntry[] = []; let truncated = false;
  for (const entry of candidates) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink() && !(await isDirectory(full))) continue;
    if (entries.length >= MAX_BROWSE_ENTRIES) { truncated = true; break; }
    entries.push(entry.isSymbolicLink() ? { name: entry.name, path: full, symlink: true } : { name: entry.name, path: full });
  }
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, home, entries, truncated };
}
