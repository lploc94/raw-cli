import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { errorResult, indexedResult, indexedResultFits, type IndexedResult } from "./results.js";
import type { ToolResult } from "./types.js";

const PATCH_BYTES = 1024 * 1024;
const SOURCE_BYTES = 16 * 1024 * 1024;
const STAGED_BYTES = 64 * 1024 * 1024;
const FILE_LINES = 200_000;
const MATCH_LINE_VISITS = 8_000_000;
interface PatchLine { kind: " " | "+" | "-"; text: string }
interface Hunk { lines: PatchLine[]; eof: boolean }
export interface ParsedPatchChange {
  kind: "add" | "update" | "delete";
  path: string; rawPath: string; destination?: string; rawDestination?: string;
  hunks: Hunk[]; added: string[]; noNewline: boolean;
}
export interface ParsedFilePatch { changes: ParsedPatchChange[] }
export interface CompletedPatchChange {
  path: string; oldPath?: string; kind: "added" | "modified" | "deleted" | "renamed";
  before?: Buffer; after?: Buffer;
}
export interface PatchApplyOptions {
  maxOutputBytes: number; signal?: AbortSignal;
  onCompleted?: (change: CompletedPatchChange) => void | Promise<void>;
}
interface Snapshot { bytes: Buffer; hash: string; mode: number; dev: number; ino: number }
interface StagedChange { change: ParsedPatchChange; source?: Snapshot; after?: Buffer }
export interface StagedFilePatch { changes: StagedChange[] }
class PatchError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new PatchError(code); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function checkLines(bytes: Buffer): void {
  let lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (const byte of bytes) if (byte === 10 && ++lines > FILE_LINES) fail("patch_too_many_lines");
}
const code = (error: unknown): string => {
  const candidate = error instanceof PatchError ? error.code : (error as NodeJS.ErrnoException)?.code;
  return typeof candidate === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(candidate) ? candidate : "patch_io_error";
};

/** Pure syntax and lexical target parsing, shared by inspection and execution. No filesystem access. */
export function parseFilePatch(source: string, cwd: string): ParsedFilePatch {
  return parsePatch(source, cwd, true);
}

/** Validate grammar without guessing the execution cwd or inventing lexical target aliases. */
export function validateFilePatchSyntax(source: string): void {
  parsePatch(source, "/", false);
}

function parsePatch(source: string, cwd: string, checkResolvedTargets: boolean): ParsedFilePatch {
  if (typeof source !== "string" || Buffer.byteLength(source) > PATCH_BYTES || source.includes("\0")) fail("patch_invalid_size_or_binary");
  const lines = source.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") fail("patch_invalid_envelope");
  const changes: ParsedPatchChange[] = [];
  const targets = new Set<string>();
  let targetCount = 0;
  const target = (raw: string): string => {
    if (!raw || raw.trim() !== raw || /[\r\n\0]/.test(raw)) fail("patch_invalid_path");
    const path = resolve(cwd, raw);
    if (++targetCount > 64) fail("patch_too_many_paths");
    if (!checkResolvedTargets) return path;
    if (targets.has(path)) fail("patch_repeated_target");
    // A target cannot also be another target's parent (including add-directory conflicts).
    for (const other of targets) if (path.startsWith(other + sep) || other.startsWith(path + sep)) fail("patch_conflicting_targets");
    targets.add(path);
    if (targets.size > 64) fail("patch_too_many_paths");
    return path;
  };
  let cursor = 0;
  while (cursor < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[cursor++]!);
    if (!header) fail("patch_invalid_header");
    const rawPath = header![2]!;
    const kind = header![1] === "Add" ? "add" : header![1] === "Update" ? "update" : "delete";
    const change: ParsedPatchChange = { kind, path: target(rawPath), rawPath, hunks: [], added: [], noNewline: false };
    if (kind === "update" && lines[cursor]?.startsWith("*** Move to: ")) {
      change.rawDestination = lines[cursor++]!.slice("*** Move to: ".length);
      change.destination = target(change.rawDestination);
    }
    if (kind === "add") {
      while (lines[cursor]?.startsWith("+")) change.added.push(lines[cursor++]!.slice(1));
    } else if (kind === "update") {
      while (lines[cursor] === "@@") {
        cursor++;
        const hunk: Hunk = { lines: [], eof: false };
        while (cursor < lines.length && /^[ +\-]/.test(lines[cursor]!)) {
          const line = lines[cursor++]!;
          hunk.lines.push({ kind: line[0] as PatchLine["kind"], text: line.slice(1) });
        }
        if (!hunk.lines.length) fail("patch_empty_hunk");
        if (lines[cursor] === "*** End of File") { hunk.eof = true; cursor++; }
        change.hunks.push(hunk);
        if (hunk.eof && lines[cursor] === "@@") fail("patch_hunk_after_eof");
      }
      if (!change.hunks.length) fail("patch_missing_hunk");
    }
    if (kind !== "delete" && lines[cursor] === "*** No newline at end of file") { change.noNewline = true; cursor++; }
    changes.push(change);
  }
  if (!changes.length) fail("patch_empty");
  return { changes };
}

type PatchEffect = { path: string; operation: "write" | "delete" | "rename_source" | "rename_destination" };
export function describePatchEffects(parsed: ParsedFilePatch): { files: PatchEffect[] } {
  return { files: parsed.changes.flatMap<PatchEffect>(change => change.destination
    ? [{ path: change.path, operation: "rename_source" as const }, { path: change.destination, operation: "rename_destination" as const }]
    : [{ path: change.path, operation: change.kind === "delete" ? "delete" as const : "write" as const }]) };
}

/** All existing ancestors must be directories and must not be symlinks. Missing suffixes are allowed. */
async function safeParents(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  const parts = relative(root, dirname(path)).split(sep).filter(Boolean);
  for (const component of ["", ...parts]) {
    if (component) current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("patch_symlink_path");
      if (!info.isDirectory()) fail("patch_parent_not_directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function absent(path: string): Promise<void> {
  await safeParents(path);
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  fail("patch_destination_exists");
}

async function snapshot(path: string): Promise<Snapshot> {
  await safeParents(path);
  const before = await lstat(path);
  if (before.isSymbolicLink()) fail("patch_symlink_path");
  if (!before.isFile()) fail("patch_not_regular_file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) fail("patch_source_changed");
    if (info.size > SOURCE_BYTES) fail("patch_source_too_large");
    const buffer = Buffer.alloc(Math.min(SOURCE_BYTES + 1, info.size + 1));
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== info.size) fail("patch_source_changed");
    const bytes = buffer.subarray(0, count);
    if (bytes.includes(0)) fail("patch_binary_source");
    checkLines(bytes);
    try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail("patch_invalid_utf8"); }
    return { bytes, hash: hash(bytes), mode: info.mode & 0o7777, dev: info.dev, ino: info.ino };
  } finally { await handle.close(); }
}

interface SourceLine { text: string; ending: string }
function applyHunks(bytes: Buffer, change: ParsedPatchChange, work: { remaining: number }): Buffer {
  const decoded = bytes.toString("utf8");
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? decoded.slice(1) : decoded;
  const source: SourceLine[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    if (end < 0) { source.push({ text: text.slice(offset), ending: "" }); break; }
    const crlf = end > offset && text[end - 1] === "\r";
    source.push({ text: text.slice(offset, crlf ? end - 1 : end), ending: crlf ? "\r\n" : "\n" });
    offset = end + 1;
  }
  const fallback = source.find(line => line.ending)?.ending ?? "\n";
  const output: SourceLine[] = [];
  let cursor = 0;
  for (const hunk of change.hunks) {
    const expected = hunk.lines.filter(line => line.kind !== "+");
    const matches: number[] = [];
    if (!expected.length) {
      if (source.length || cursor || output.length) fail("patch_unanchored_insertion");
      matches.push(0);
    } else {
      // KMP keeps repeated large contexts linear instead of rescanning every prefix at each source line.
      const prefix = new Array<number>(expected.length).fill(0);
      for (let i = 1, matched = 0; i < expected.length; i++) {
        while (matched && expected[i]!.text !== expected[matched]!.text) matched = prefix[matched - 1]!;
        if (expected[i]!.text === expected[matched]!.text) matched++;
        prefix[i] = matched;
      }
      for (let i = cursor, matched = 0; i < source.length; i++) {
        if (--work.remaining < 0) fail("patch_matching_limit");
        while (matched && source[i]!.text !== expected[matched]!.text) matched = prefix[matched - 1]!;
        if (source[i]!.text === expected[matched]!.text) matched++;
        if (matched === expected.length) {
          if (!hunk.eof || i === source.length - 1) matches.push(i - matched + 1);
          if (matches.length > 1) break;
          matched = prefix[matched - 1]!;
        }
      }
    }
    if (matches.length !== 1) fail(matches.length ? "patch_ambiguous_context" : "patch_context_not_found");
    const at = matches[0]!;
    for (let i = cursor; i < at; i++) output.push({ ...source[i]! });
    let input = at;
    for (const line of hunk.lines) {
      if (line.kind === " ") output.push({ ...source[input++]! });
      else if (line.kind === "-") input++;
      else {
        const ending = source[input]?.ending || source[input - 1]?.ending || fallback;
        output.push({ text: line.text, ending });
      }
    }
    cursor = input;
  }
  for (let i = cursor; i < source.length; i++) output.push({ ...source[i]! });
  // A newly inserted line after the old unterminated EOF still requires a boundary separator.
  for (let i = 0; i < output.length - 1; i++) if (!output[i]!.ending) output[i]!.ending = fallback;
  if (output.length) output[output.length - 1]!.ending = change.noNewline || !text.endsWith("\n") ? "" : output.at(-1)!.ending || fallback;
  return Buffer.from(bom + output.map(line => line.text + line.ending).join(""));
}

/** Reads/validates every file and computes every output before any filesystem mutation. */
export async function stageFilePatch(parsed: ParsedFilePatch): Promise<StagedFilePatch> {
  const changes: StagedChange[] = [];
  const work = { remaining: MATCH_LINE_VISITS };
  let retained = 0;
  const account = (bytes: Buffer): Buffer => {
    retained += bytes.length;
    if (retained > STAGED_BYTES) fail("patch_staging_too_large");
    checkLines(bytes);
    return bytes;
  };
  for (const change of parsed.changes) {
    if (change.kind === "add") {
      await absent(change.path);
      const text = change.added.join("\n") + (change.added.length && !change.noNewline ? "\n" : "");
      changes.push({ change, after: account(Buffer.from(text)) });
    } else {
      const source = await snapshot(change.path);
      account(source.bytes);
      if (change.destination) await absent(change.destination);
      changes.push({ change, source, ...(change.kind === "update" ? { after: account(applyHunks(source.bytes, change, work)) } : {}) });
    }
  }
  return { changes };
}

async function recheck(staged: StagedChange): Promise<void> {
  if (staged.source) {
    const current = await snapshot(staged.change.path);
    if (current.hash !== staged.source.hash || current.mode !== staged.source.mode
      || current.dev !== staged.source.dev || current.ino !== staged.source.ino) fail("patch_source_changed");
  } else await absent(staged.change.path);
  if (staged.change.destination) await absent(staged.change.destination);
}

function reserved(parsed: ParsedFilePatch): IndexedResult[] {
  return parsed.changes.map((change, index) => ({ index, path: change.rawPath, mode: "patch", status: "skipped",
    ...(change.rawDestination ? { destination: change.rawDestination } : {}),
    error: "x".repeat(120), bytes_written: 999999999, destination_created: true }));
}
function basic(change: ParsedPatchChange, index: number): IndexedResult {
  return { index, path: change.rawPath, mode: "patch", status: "skipped",
    ...(change.rawDestination ? { destination: change.rawDestination } : {}) };
}
async function notify(options: PatchApplyOptions, change: CompletedPatchChange): Promise<void> {
  try { await options.onCompleted?.(change); } catch { /* UI observers cannot change a completed filesystem outcome. */ }
}

/** Global recheck, then ordered application. Does not promise a cross-file transaction. */
export async function applyStagedFilePatch(staged: StagedFilePatch, options: PatchApplyOptions): Promise<ToolResult> {
  const parsed = { changes: staged.changes.map(item => item.change) };
  if (!indexedResultFits(reserved(parsed), options.maxOutputBytes)) return errorResult("output_budget_too_small", "patch outcomes exceed output budget");
  const rows = parsed.changes.map(basic);
  if (options.signal?.aborted) return indexedResult(rows.map(row => ({ ...row, error: "aborted" })), options.maxOutputBytes, true);
  try { for (const item of staged.changes) await recheck(item); }
  catch (error) { return errorResult("patch_preflight_failed", code(error)); }
  let stopped = false;
  for (const [index, item] of staged.changes.entries()) {
    const { change, source, after } = item;
    if (stopped || options.signal?.aborted) { rows[index] = { ...rows[index]!, error: options.signal?.aborted ? "aborted" : "prior_patch_failure" }; continue; }
    let temporary: string | undefined;
    let destinationCreated = false;
    try {
      await recheck(item);
      if (options.signal?.aborted) fail("aborted");
      if (change.kind === "delete") {
        await unlink(change.path);
        await notify(options, { path: change.path, kind: "deleted", before: source!.bytes });
      } else {
        const destination = change.destination ?? change.path;
        await mkdir(dirname(destination), { recursive: true });
        await safeParents(destination);
        temporary = join(dirname(destination), `.raw-patch-${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", source?.mode ?? 0o666);
        try { await handle.writeFile(after!); }
        finally { await handle.close(); }
        if (source) await chmod(temporary, source.mode);
        await recheck(item);
        if (options.signal?.aborted) fail("aborted");
        if (change.kind === "add" || change.destination) {
          // Atomic no-clobber publication. A concurrent destination creation fails instead of being overwritten.
          await link(temporary, destination);
          destinationCreated = true;
          if (change.destination) await unlink(change.path);
        } else await rename(temporary, destination);
        await notify(options, { path: destination, kind: change.destination ? "renamed" : change.kind === "add" ? "added" : "modified",
          ...(change.destination ? { oldPath: change.path } : {}), ...(source ? { before: source.bytes } : {}), after: after! });
      }
      rows[index] = { ...rows[index]!, status: "ok", bytes_written: after?.length ?? 0 };
    } catch (error) {
      stopped = true;
      if (destinationCreated && change.destination) await notify(options, { path: change.destination, kind: "added", after: after! });
      rows[index] = { ...rows[index]!, status: code(error) === "aborted" ? "skipped" : "error", error: code(error),
        ...(destinationCreated ? { destination_created: true } : {}) };
    } finally {
      if (temporary) { try { await unlink(temporary); } catch { /* The target outcome remains truthful if temporary cleanup fails. */ } }
    }
  }
  return indexedResult(rows, options.maxOutputBytes, rows.some(row => row.status !== "ok"));
}

export async function applyFilePatch(parsed: ParsedFilePatch, options: PatchApplyOptions): Promise<ToolResult> {
  if (!indexedResultFits(reserved(parsed), options.maxOutputBytes)) return errorResult("output_budget_too_small", "patch outcomes exceed output budget");
  if (options.signal?.aborted) return indexedResult(parsed.changes.map((change, index) => ({ ...basic(change, index), error: "aborted" })), options.maxOutputBytes, true);
  let staged: StagedFilePatch;
  try { staged = await stageFilePatch(parsed); }
  catch (error) { return errorResult("patch_preflight_failed", code(error)); }
  return applyStagedFilePatch(staged, options);
}
