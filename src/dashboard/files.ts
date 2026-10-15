import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { UserBlock } from "../llm/types.js";
import { MAX_IMAGE_BYTES } from "../tools/types.js";
import { DashboardError } from "./errors.js";
import { MAX_LISTED_PATHS, MAX_TEXT_BYTES } from "./limits.js";

// Only version-control internals and dependency trees are noise everywhere; a git repository's own ignore rules decide the rest.
const IGNORED = new Set([".git", "node_modules"]);
const MAX_LISTED = 500_000;
const MAX_DEPTH = 64;
const WALK_BUDGET_MS = 2_000;
const GIT_TIMEOUT_MS = 3_000;
const LIST_TTL_MS = 5_000;
const run = promisify(execFile);

export interface FileHit { path: string; name: string }

function ignoredSegment(path: string): boolean {
  return path.split(/[\\/]/).some((part) => IGNORED.has(process.platform === "win32" ? part.toLowerCase() : part));
}

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
      if (ignoredSegment(entry.name) || entry.isSymbolicLink()) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) queue.push({ dir: path, depth: depth + 1 }); }
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

const listings = new Map<string, { at: number; files: Promise<string[]> }>();
/** One listing per workspace for a few seconds, so each keystroke of a query does not rescan the tree. */
function workspaceFiles(cwd: string, root: string, bypassCache = false): Promise<string[]> {
  const cached = listings.get(root);
  if (!bypassCache && cached && Date.now() - cached.at < LIST_TTL_MS) return cached.files;
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
    if (ignoredSegment(path)) continue;
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

/** The workspace-relative path of a `resource_link` built by workspaceFileLink; undefined when it is not inside `root` (a real path). */
export function workspaceLinkPath(root: string, uri: string): string | undefined {
  let path: string; try { path = fileURLToPath(uri); } catch { return undefined; }
  if (path === root || !within(root, path)) return undefined;
  return relative(root, path).split(sep).join("/");
}

/** The caps live in their own dependency-free module so the web bundle can import them too. */
export { MAX_LISTED_PATHS, MAX_TEXT_BYTES } from "./limits.js";
/** How much of a file decides whether it is binary at all: a NUL in here means "do not show this". */
const BINARY_WINDOW = 8192;

export interface WorkspaceFileEntry { path: string; name: string }
export interface WorkspaceFileListing { root: string; entries: WorkspaceFileEntry[]; total: number; truncated: boolean }
/** Text, cut at most at `MAX_TEXT_BYTES`, or the report that the file is binary and was not decoded at all. */
export type WorkspaceFileText =
  | { path: string; bytes: number; text: string; truncated: boolean }
  | { path: string; bytes: number; binary: true };

/** The raster formats the viewer can render; SVG is deliberately absent (see docs/dashboard-api.md). */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The media type a workspace file is served as in raw mode, or undefined when it is not one of the raster formats. */
export function imageMediaType(name: string): string | undefined {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension !== undefined && Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[extension] : undefined;
}

interface ResolvedFile { real: string; path: string; size: number }

/**
 * Resolves a client-supplied workspace-relative path, applying the rule `workspaceFileLink` already applies: a path
 * that leaves the workspace, names the workspace root itself, is not a regular file, or has since been deleted is an
 * invalid file rather than a read. Both readers below go through it so the rule has one home.
 */
async function resolveWorkspaceFile(root: string, raw: unknown): Promise<ResolvedFile> {
  const invalid = (message: string) => new DashboardError(422, "invalid_file", message);
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || raw.includes("\0")) throw invalid("Choose a file inside this workspace");
  if (isAbsolute(raw) || ignoredSegment(raw) || raw.split(/[\\/]/).some((part) => part === "..")) throw invalid("Files must be inside the workspace");
  let real: string; let base: string;
  try { base = await realpath(root); real = await realpath(join(base, raw)); } catch { throw invalid("That file no longer exists"); }
  if (real === base || !within(base, real)) throw invalid("Files must be inside the workspace");
  const path = relative(base, real).split(sep).join("/");
  if (ignoredSegment(path)) throw invalid("Files must be inside the workspace");
  let info; try { info = await stat(real); } catch { throw invalid("That file no longer exists"); }
  if (!info.isFile()) throw invalid("Only files can be opened");
  return { real, path, size: info.size };
}

/** Reads at most `length` bytes from an offset, looping because one `read` may return fewer than asked for. */
async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/** Drops a trailing partial UTF-8 sequence, so a cut at a byte boundary is not mistaken for broken text. */
function trimPartialSequence(bytes: Buffer): Buffer {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end--;
  if (end === 0) return bytes;
  const lead = bytes[end - 1]!;
  const expected = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return end - 1 + expected <= bytes.length ? bytes : bytes.subarray(0, end - 1);
}

/**
 * One workspace file for display (docs/dashboard-api.md): its text, cut at `MAX_TEXT_BYTES`, or the report that it
 * is binary and was not decoded at all. Binary is a NUL in the first `BINARY_WINDOW` bytes *or* bytes that are not
 * UTF-8 at all, so a Latin-1 file is named rather than shown as replacement characters.
 */
export async function readWorkspaceFileText(root: string, raw: unknown): Promise<WorkspaceFileText> {
  const { real, path, size } = await resolveWorkspaceFile(root, raw);
  const handle = await open(real, "r");
  try {
    const window = await readExactly(handle, Math.min(BINARY_WINDOW, size), 0);
    if (window.includes(0)) return { path, bytes: size, binary: true };
    const truncated = size > MAX_TEXT_BYTES;
    const body = await readExactly(handle, Math.min(size, MAX_TEXT_BYTES), 0);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(truncated ? trimPartialSequence(body) : body); }
    catch { return { path, bytes: size, binary: true }; }
    return { path, bytes: size, text, truncated };
  } finally { await handle.close(); }
}

/**
 * One workspace image's bytes for the viewer's `raw=1` mode: the same confinement, the shared `MAX_IMAGE_BYTES`
 * budget (so this and `view_image` cannot drift apart), and only the raster formats — anything else is 415.
 */
export async function readWorkspaceImage(root: string, raw: unknown): Promise<{ bytes: Buffer; mediaType: string }> {
  const { real, path } = await resolveWorkspaceFile(root, raw);
  const mediaType = imageMediaType(path);
  if (!mediaType) throw new DashboardError(415, "unsupported_media_type", "Only raster images can be shown");
  const handle = await open(real, "r");
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    // Inclusive end reads at most one byte beyond the budget, even if a writer grows the open file.
    const stream = handle.createReadStream({ start: 0, end: MAX_IMAGE_BYTES, autoClose: false });
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) {
        throw new DashboardError(415, "unsupported_media_type", `Images are shown up to ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MiB`);
      }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, length), mediaType };
  } finally { await handle.close(); }
}

/**
 * The workspace's files for the dashboard's Files tab: the same git-aware view `@` references use, so the model and
 * the reader never disagree about what exists. Paths stay workspace-relative, `.git` and `node_modules` are left
 * out either way, and `total` lets a caller say how many of how many it is showing. `max` exists so the cap is
 * testable without making twenty thousand files; `bypassCache` is used by an explicit Files reload.
 */
export async function listWorkspaceFiles(root: string, options: { max?: number; bypassCache?: boolean } = {}): Promise<WorkspaceFileListing> {
  let canonical: string;
  try { canonical = await realpath(root); if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory"); }
  catch { throw new DashboardError(422, "unreadable_directory", "This workspace cannot be read"); }
  const listed = (await workspaceFiles(canonical, canonical, options.bypassCache === true)).filter((path) => !ignoredSegment(path));
  const max = options.max ?? MAX_LISTED_PATHS;
  return { root: canonical, entries: listed.slice(0, max).map((path) => ({ path, name: basename(path) })), total: listed.length, truncated: listed.length > max };
}
