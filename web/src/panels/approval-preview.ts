import type { Approval } from "../../../src/dashboard/approvals.js";

/**
 * The bounds of one preview: the work stays bounded however large an argument is. The entry bound is the effects
 * schema's own maximum (`maxItems: 128` in the three editing tools' manifests), so a declared tool's change is never
 * cut silently; anything beyond it is reported as `omitted`.
 */
export const MAX_PREVIEW_ENTRIES = 128;
export const MAX_PREVIEW_LINES = 2000;
export const MAX_PREVIEW_BYTES = 64 * 1024;
export const PREVIEW_TRUNCATED = "… [preview truncated]";

export type PreviewOperation = "write" | "edit" | "delete" | "rename_source" | "rename_destination";

export interface ApprovalPreviewEntry {
  key: string;
  /** Absolute, as the intended effects report it. */
  path: string;
  /** The name and folder the panel shows: relative to the session directory, or absolute outside it. */
  display: { name: string; folder: string };
  operation?: PreviewOperation;
  /** What the call intends to change, in the shape `<Diff>` reads: headers, then the lines as written. */
  diff?: string;
  added?: number;
  removed?: number;
  note?: string;
}

export interface ApprovalPreviewList {
  entries: ApprovalPreviewEntry[];
  /** Intended files beyond the entry bound, which the panel says out loud rather than dropping silently. */
  omitted: number;
}

const OPERATIONS = new Set<string>(["write", "edit", "delete", "rename_source", "rename_destination"]);
/** The dashboard stores the registry alias (`name`) rather than ToolApprovalRequest.identity; canonical ids are accepted only explicitly. */
const BUILTIN_PREVIEW_TOOLS: Readonly<Record<string, "write_file" | "edit_file" | "apply_patch">> = {
  write_file: "write_file",
  edit_file: "edit_file",
  apply_patch: "apply_patch",
  "builtin/write_file": "write_file",
  "builtin/edit_file": "edit_file",
  "builtin/apply_patch": "apply_patch",
};
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;
const slashes = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
const stringArg = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** An argument's lines: CRLF folded, one trailing newline dropped, an empty text having none. */
function lines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

/** The path as the user reads it: relative to the session directory when it is inside it. */
function relativeTo(path: string, cwd: string | undefined): string {
  const full = slashes(path);
  if (!cwd) return full;
  const root = slashes(cwd);
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}

/** A path from a patch is relative to the session directory; one that is already absolute is kept. */
function absoluteTo(path: string, cwd: string | undefined): string {
  const full = slashes(path);
  if (!cwd || /^([a-zA-Z]:\/|\/)/.test(full)) return full;
  return `${slashes(cwd)}/${full}`;
}

function displayOf(path: string, cwd: string | undefined): { shown: string; display: { name: string; folder: string } } {
  const shown = relativeTo(path, cwd);
  const cut = shown.lastIndexOf("/") + 1;
  return { shown, display: { name: shown.slice(cut), folder: cut > 0 ? shown.slice(0, cut - 1) || shown.slice(0, cut) : "project root" } };
}

function entry(index: number, path: string, cwd: string | undefined, rest: Omit<ApprovalPreviewEntry, "key" | "path" | "display">): ApprovalPreviewEntry {
  return { key: `${index}:${path}`, path, display: displayOf(path, cwd).display, ...rest };
}

/**
 * A diff-shaped preview: file headers, then the body lines as the call wrote them, cut at the first bound reached.
 * A file the call creates is headed against `/dev/null`, the way the host's own diffs report a new file.
 */
function buildDiff(shown: string, body: readonly string[], from = `a/${shown}`): { diff: string; cut: boolean } {
  const head = `--- ${from}\n+++ b/${shown}`;
  let budget = MAX_PREVIEW_BYTES - byteLength(head);
  const kept: string[] = [];
  let cut = false;
  for (const line of body) {
    const size = byteLength(line) + 1;
    if (kept.length >= MAX_PREVIEW_LINES || size > budget) { cut = true; break; }
    kept.push(line);
    budget -= size;
  }
  const rest = kept.length ? `\n${kept.join("\n")}` : "";
  return { diff: cut ? `${head}${rest}\n${PREVIEW_TRUNCATED}` : `${head}${rest}`, cut };
}

/** The files an approval intends to change, as the host's effects projection reported them. */
function effectFiles(effects: Record<string, unknown> | undefined): Array<{ path: string; operation?: PreviewOperation }> {
  const value = effects?.files;
  if (!Array.isArray(value)) return [];
  const files: Array<{ path: string; operation?: PreviewOperation }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== "string" || !path) continue;
    const operation = (item as { operation?: unknown }).operation;
    files.push({ path, ...(typeof operation === "string" && OPERATIONS.has(operation) ? { operation: operation as PreviewOperation } : {}) });
  }
  return files;
}

function writeEntries(args: Record<string, unknown>, files: Array<{ path: string; operation?: PreviewOperation }>, cwd: string | undefined): ApprovalPreviewList {
  const path = files[0]?.path ?? stringArg(args.path);
  if (!path) return { entries: [], omitted: 0 };
  const content = typeof args.content === "string" ? args.content : undefined;
  const contentLines = content === undefined ? [] : lines(content);
  const built = content === undefined ? undefined : buildDiff(displayOf(path, cwd).shown, contentLines.map((line) => `+${line}`));
  return { entries: [entry(0, path, cwd, {
    operation: files[0]?.operation ?? "write",
    ...(built ? { diff: built.diff, added: contentLines.length } : {}),
    note: "The file's previous content is not read; the preview shows what will be written.",
  })], omitted: Math.max(0, files.length - 1) };
}

function editEntries(args: Record<string, unknown>, files: Array<{ path: string; operation?: PreviewOperation }>, cwd: string | undefined): ApprovalPreviewList {
  const path = files[0]?.path ?? stringArg(args.path);
  if (!path) return { entries: [], omitted: 0 };
  const oldText = typeof args.old_string === "string" ? args.old_string : undefined;
  const newText = typeof args.new_string === "string" ? args.new_string : undefined;
  const known = oldText !== undefined && newText !== undefined;
  const oldLines = oldText === undefined ? [] : lines(oldText);
  const newLines = newText === undefined ? [] : lines(newText);
  const built = known ? buildDiff(displayOf(path, cwd).shown, ["@@", ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)]) : undefined;
  return { entries: [entry(0, path, cwd, {
    operation: files[0]?.operation ?? "edit",
    ...(built ? { diff: built.diff, added: newLines.length, removed: oldLines.length } : {}),
    ...(args.replace_all === true ? { note: "Every occurrence is replaced." } : {}),
  })], omitted: Math.max(0, files.length - 1) };
}

interface PatchSection { kind: "add" | "update" | "delete"; path: string; destination?: string; body: string[] }

/** The patch envelope's sections. Only the markers this format defines are read; every other line is body. */
function patchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  for (const line of lines(patch)) {
    const marker = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (marker) {
      current = { kind: marker[1]!.toLowerCase() as PatchSection["kind"], path: marker[2]!.trim(), body: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("*** ")) {
      const move = /^\*\*\* Move to: (.+)$/.exec(line);
      if (move && current) current.destination = move[1]!.trim();
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections;
}

function patchEntries(args: Record<string, unknown>, files: Array<{ path: string; operation?: PreviewOperation }>, cwd: string | undefined): ApprovalPreviewList {
  const patch = typeof args.patch === "string" ? args.patch : undefined;
  const sections = patch === undefined ? [] : patchSections(patch);
  if (!sections.length) return {
    // A patch the client cannot read: the host's own projection still names every file it covers.
    entries: files.slice(0, MAX_PREVIEW_ENTRIES).map((file, index) => entry(index, file.path, cwd, {
      ...(file.operation ? { operation: file.operation } : {}),
      note: "The intended change cannot be shown; the raw patch is in the arguments below.",
    })),
    omitted: Math.max(0, files.length - MAX_PREVIEW_ENTRIES),
  };
  // A rename reports both paths, so the host's projection covers one entry per section plus one per destination.
  const covered = sections.reduce((total, section) => total + (section.destination ? 2 : 1), 0);
  const authoritative = files.length === covered ? files : undefined;
  const entries: ApprovalPreviewEntry[] = [];
  let at = 0;
  const push = (item: ApprovalPreviewEntry) => { if (entries.length < MAX_PREVIEW_ENTRIES) entries.push(item); };
  for (const section of sections) {
    if (entries.length >= MAX_PREVIEW_ENTRIES) break;
    // The host resolves a patch target lexically against the session directory; its projection is the path that
    // will actually be written, so it wins whenever it lines up with the patch's own sections.
    const source = authoritative?.[at]?.path ?? absoluteTo(section.path, cwd);
    const destination = section.destination === undefined ? undefined : authoritative?.[at + 1]?.path ?? absoluteTo(section.destination, cwd);
    const shown = displayOf(source, cwd).shown;
    const built = section.kind === "delete" ? undefined : buildDiff(shown, section.body, section.kind === "add" ? "/dev/null" : undefined);
    push(entry(entries.length, source, cwd, {
      operation: authoritative?.[at]?.operation ?? (section.kind === "delete" ? "delete" : destination ? "rename_source" : "write"),
      ...(built ? { diff: built.diff, added: section.body.filter((line) => line.startsWith("+")).length, removed: section.body.filter((line) => line.startsWith("-")).length } : {}),
      ...(section.kind === "delete" ? { note: "The file will be deleted." }
        : destination ? { note: `Renamed to ${displayOf(destination, cwd).shown}.` } : {}),
    }));
    at++;
    if (destination === undefined) continue;
    push(entry(entries.length, destination, cwd, {
      operation: authoritative?.[at]?.operation ?? "rename_destination",
      note: `Renamed from ${shown}.`,
    }));
    at++;
  }
  return { entries, omitted: Math.max(0, covered - entries.length) };
}

/**
 * What an approval intends to change, for the side panel's Approvals tab (docs/side-panel-design.md §3.3). The
 * arguments carry the proposed text and the effects name the files, so nothing is read from disk and no hunk
 * numbering is invented: a header and the lines as the call wrote them. The request name is matched against the
 * bundled registry aliases and canonical ids explicitly; splitting `/` or `#` would let a package tool masquerade as
 * a built-in editing tool. Pure, so it is unit tested.
 */
export function approvalPreviews(approval: Approval, cwd: string | undefined): ApprovalPreviewList {
  const args = approval.arguments ?? {};
  const files = effectFiles(approval.effects);
  const tool = BUILTIN_PREVIEW_TOOLS[approval.name];
  if (tool === "apply_patch") return patchEntries(args, files, cwd);
  if (tool === "write_file") return writeEntries(args, files, cwd);
  if (tool === "edit_file") return editEntries(args, files, cwd);
  return {
    entries: files.slice(0, MAX_PREVIEW_ENTRIES).map((file, index) => entry(index, file.path, cwd, {
      ...(file.operation ? { operation: file.operation } : {}),
      note: "No file preview for this tool.",
    })),
    omitted: Math.max(0, files.length - MAX_PREVIEW_ENTRIES),
  };
}
