import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { UserBlock } from "../llm/types.js";
import { DashboardError } from "./errors.js";

// Only version-control internals and dependency trees are noise everywhere; a git repository's own ignore rules decide the rest.
const IGNORED = new Set([".git", "node_modules"]);
const MAX_LISTED = 500_000;
const MAX_DEPTH = 64;
const WALK_BUDGET_MS = 2_000;
const GIT_TIMEOUT_MS = 3_000;
const LIST_TTL_MS = 5_000;
const run = promisify(execFile);

export interface FileHit { path: string; name: string }

function within(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

function score(path: string, query: string): number {
  const lower = path.toLowerCase(); const name = basename(lower);
  if (!query) return path.split("/").length * 1000 + path.length;
  if (name === query) return 0;
  if (name.startsWith(query)) return 100 + name.length;
  if (name.includes(query)) return 200 + name.length;
  if (lower.includes(query)) return 300 + lower.length;
  let at = 0;
  for (const ch of query) { at = lower.indexOf(ch, at); if (at < 0) return Infinity; at++; }
  return 1000 + lower.length;
}

/** Files git would show for the workspace: tracked plus untracked, minus everything its ignore rules exclude. */
async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const files = [...new Set(stdout.split("\0").filter(Boolean))];
    return files.length > MAX_LISTED ? files.slice(0, MAX_LISTED) : files;
  } catch { return undefined; }
}

/** Outside git: a breadth-first, non-following walk bounded by entry count and time, skipping only `IGNORED`. */
async function walkFiles(cwd: string, root: string): Promise<string[]> {
  const files: string[] = [];
  const deadline = Date.now() + WALK_BUDGET_MS;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }];
  for (let next = 0; next < queue.length && visited < MAX_LISTED && Date.now() < deadline; next++) {
    const { dir, depth } = queue[next]!;
    let entries;
    try {
      // A directory can be swapped for a symlink after it was queued. Read the resolved path, then confirm the
      // directory still resolves to it inside the workspace; otherwise drop the listing.
      const resolved = dir ? await realpath(join(cwd, dir)) : root;
      if (!within(root, resolved)) continue;
      entries = await readdir(resolved, { withFileTypes: true });
      if (dir && (await realpath(join(cwd, dir))) !== resolved) continue;
    } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_LISTED) break;
      if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) queue.push({ dir: path, depth: depth + 1 }); }
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

const listings = new Map<string, { at: number; files: Promise<string[]> }>();
/** One listing per workspace for a few seconds, so each keystroke of a query does not rescan the tree. */
function workspaceFiles(cwd: string, root: string): Promise<string[]> {
  const cached = listings.get(root);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.files;
  const files = gitFiles(root).then((listed) => listed ?? walkFiles(cwd, root));
  listings.delete(root);
  if (listings.size >= 32) listings.delete(listings.keys().next().value!);
  listings.set(root, { at: Date.now(), files });
  return files;
}

/** Workspace files for `@` references: git's view of the repository when available, otherwise a bounded walk. */
export async function searchWorkspaceFiles(cwd: string, rawQuery: string, limit: number): Promise<FileHit[]> {
  const query = rawQuery.trim().toLowerCase();
  let root: string;
  try { root = await realpath(cwd); } catch { return []; }
  const hits: Array<{ path: string; rank: number }> = [];
  for (const path of await workspaceFiles(cwd, root)) {
    if (path.split("/").some((part) => IGNORED.has(part))) continue;
    const rank = score(path, query);
    if (rank !== Infinity) hits.push({ path, rank });
  }
  return hits.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path)).slice(0, limit).map((hit) => ({ path: hit.path, name: basename(hit.path) }));
}

/** Resolves a client-supplied workspace-relative path to a `resource_link` block, never leaving the workspace. */
export async function workspaceFileLink(cwd: string, raw: unknown): Promise<UserBlock> {
  const invalid = (message: string) => new DashboardError(422, "invalid_file", message);
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || raw.includes("\0")) throw invalid("Choose a file inside this workspace");
  if (isAbsolute(raw) || raw.split(/[\\/]/).some((part) => part === "..")) throw invalid("Files must be inside the workspace");
  let real: string; let root: string;
  try { root = await realpath(cwd); real = await realpath(join(root, raw)); } catch { throw invalid("That file no longer exists"); }
  if (real === root || !within(root, real)) throw invalid("Files must be inside the workspace");
  let info; try { info = await stat(real); } catch { throw invalid("That file no longer exists"); }
  if (!info.isFile()) throw invalid("Only files can be referenced");
  return { type: "resource_link", uri: pathToFileURL(real).href, name: basename(real), size: info.size };
}
