import { constants as fsConstants } from "node:fs";
import { parseFilePatch, applyFilePatch } from "./file-patch.js";
import { changeHostData, displayPath, MAX_DIFF_SOURCE_BYTES, publishWriteChanges, type CompletedWriteChange } from "./write-changes.js";
import type { CommandActivity } from "../processes/presentation.js";
import type { ProcessContext } from "../processes/contract.js";
import type { InteractionContext } from "../interactions/contract.js";
import type { VariableContext } from "../vars/contract.js";
import { open, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { runBash } from "./process.js";
import type { ShellKind } from "./shells.js";
import { errorResult, utf8Prefix } from "./results.js";
import type { ToolResult } from "./types.js";
import type { PanelContext } from "../panels/contract.js";
import type { ToolContentPanel } from "./types.js";
import type { SelectedSkill } from "../skills/contract.js";
import type { HookDispatchResult } from "../hooks/dispatcher.js";
import type { HookEventName } from "../hooks/contract.js";
import { resolveToolPath } from "../platform/paths.js";
import { mergeEnv } from "../platform/windows.js";

export interface ToolApprovalRequest {
  identity: string;
  name: string;
  /** The display title and one-line summary of the call (docs/tool-ux-design.md §5.4), content-free for file tools. */
  title: string;
  summary: string;
  arguments: Record<string, unknown>;
  effects?: Readonly<Record<string, unknown>>;
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface ToolContext {
  /** Host accounting for actual successful builtin writes; never provider metadata. */
  onWriteCompleted?: () => void;
  commandActivity?: CommandActivity;
  interactions?: InteractionContext;
  processes?: ProcessContext;
  effects?: Readonly<Record<string, unknown>>;
  vars?: VariableContext;
  cwd: string;
  maxOutputBytes: number;
  autoApprove?: boolean;
  approve?: (request: ToolApprovalRequest) => boolean | Promise<boolean>;
  toolCallId?: string;
  /** The persisted session the call runs in; absent when the runtime has no session store. Forwarded to plugin handlers. */
  sessionId?: string;
  onStart?: (name: string, args: Record<string, unknown>) => void;
  /** `raw` is the call as the model sent it, present only when normalization changed it. */
  onHook?: (event: HookEventName, identity: string, name: string, args: Record<string, unknown>,
    result?: ToolResult, effects?: Record<string, unknown>, raw?: Record<string, unknown>) => Promise<HookDispatchResult>;
  /** Host-only: the normalized arguments of a call whose normalization changed them (docs/tool-ux-design.md §4.3). */
  onNormalized?: (args: Record<string, unknown>, notes: readonly string[]) => void;
  whitelist?: readonly string[];
  signal?: AbortSignal;
  bashPath?: string;
  skills?: readonly SelectedSkill[];
  /** raw.panel/2 streaming API for the calling tool (docs/panels-design.md §8.2). Forwarded to plugin handlers. */
  panels?: PanelContext;
  /** Host-only: receives the panel blocks `ToolRegistry.dispatch` removes from a handler result. Never forwarded to plugins. */
  /** Host-only: the handler has returned (or thrown); no further streaming updates are accepted. */
  onHandlerSettled?: () => void;
  onPanelUpdates?: (updates: ToolContentPanel[]) => void;
}

export interface ReadFileArgs { path: string; offset?: number; limit?: number }
export const READ_DEFAULT_LIMIT = 2000;
/** Room kept beside the lines for the range footer. */
const READ_FOOTER_RESERVE = 200;

const errorCode = (error: unknown, fallback: string) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code) ? code : fallback;
};

/**
 * One file window with a line-number gutter (docs/tool-ux-design.md §4.2), then a range footer such as
 * `[lines 120–199 of 431; next: offset 200]`. Lines stop at the output budget; a first line longer than it is cut.
 */
export async function readFileTool(args: ReadFileArgs, context: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(context.cwd, args.path);
  const shown = displayPath(path, context.cwd);
  const offset = args.offset ?? 1;
  const last = args.limit === undefined ? offset + READ_DEFAULT_LIMIT - 1 : offset + args.limit - 1;
  const budget = context.maxOutputBytes - READ_FOOTER_RESERVE;
  if (budget < 32) return errorResult("output_budget_too_small", "read_file needs room for at least one line and its footer");
  const failed = (code: string, message: string): ToolResult => ({ ...errorResult(code, message), host: { summary: shown, status: "error", path: shown } });
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) {
    const code = errorCode(error, "file_error");
    return failed(code, code === "ENOENT" ? `${shown} does not exist` : `cannot read ${shown}: ${code}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return failed("not_a_file", `${shown} is not a regular file`);
    const probe = Buffer.alloc(Math.min(info.size, 8192));
    await handle.read(probe, 0, probe.length, 0);
    if (probe.includes(0)) {
      return { isError: false, content: [{ type: "text", text: `[binary file: ${info.size} bytes; not shown]` }], host: { summary: shown, status: "ok", path: shown } };
    }
    // A file cannot have more lines than bytes plus one, so a to-the-end limit does not widen the gutter.
    const width = Math.max(4, String(Math.min(last, offset + info.size)).length);
    const lines: string[] = [];
    let used = 0;
    let total = 0;
    let stopped = false;
    let cut: { line: number; bytes: number } | undefined;
    let pending: Buffer[] = [];
    let kept = 0;
    let lineBytes = 0;
    // A line longer than the budget cannot fit, so only the prefix a cut line can show is buffered.
    const keep = budget + 4;
    const take = (line: number, raw: Buffer, bytes: number) => {
      if (stopped || line < offset || line > last) return;
      const text = raw.toString("utf8").replace(/\r$/, "");
      const rendered = `${String(line).padStart(width)}│${text}\n`;
      const size = Buffer.byteLength(rendered);
      if (used + size <= budget) { lines.push(rendered); used += size; return; }
      stopped = true;
      if (lines.length) return;
      // A first line longer than the budget is shown cut, so the call still makes progress.
      const marker = " …[line cut]\n";
      const prefix = utf8Prefix(rendered, budget - Buffer.byteLength(marker)).text;
      lines.push(prefix + marker);
      cut = { line, bytes };
    };
    for await (const rawChunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? chunk.length : newline + 1;
        const line = total + 1;
        if (line >= offset && line <= last && !stopped) {
          const part = chunk.subarray(cursor, newline < 0 ? end : newline);
          lineBytes += part.length;
          if (kept < keep) { pending.push(part.subarray(0, keep - kept)); kept += Math.min(part.length, keep - kept); }
        }
        cursor = end;
        if (newline < 0) continue;
        total++;
        take(line, Buffer.concat(pending), lineBytes);
        pending = []; kept = 0; lineBytes = 0;
      }
    }
    if (pending.length || (info.size && probe.length && !(await lastByteIsNewline(handle, info.size)))) {
      total++;
      take(total, Buffer.concat(pending), lineBytes);
    }
    const end = offset + lines.length - 1;
    const footer = total === 0 ? "[empty file]"
      : offset > total ? `[offset ${offset} is past the end: ${shown} has ${total} lines]`
        : cut ? `[line ${cut.line} of ${total} cut at the output budget (${cut.bytes} bytes); next: offset ${cut.line + 1}]`
          : end >= total ? `[lines ${offset}–${end} of ${total}; end of file]`
            : `[lines ${offset}–${end} of ${total}; next: offset ${end + 1}]`;
    return { isError: false, content: [{ type: "text", text: lines.join("") + footer }],
      host: { summary: shown, status: "ok", path: shown, ...(total && offset <= total ? { range: { start: offset, end, total } } : {}) } };
  } catch (error) {
    return failed(errorCode(error, "file_error"), `cannot read ${shown}: ${errorCode(error, "file_error")}`);
  } finally { await handle.close(); }
}

async function lastByteIsNewline(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, size - 1);
  return byte[0] === 10;
}

async function writeSnapshot(path: string): Promise<{ bytes?: Buffer; missing: boolean; partial?: boolean }> {
  let file;
  try {
    if (!(await stat(path)).isFile()) return { missing: false };
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return { missing: false };
    // One byte past the diff limit is enough to know the file is too large to diff.
    const bytes = Buffer.alloc(Math.min(info.size, MAX_DIFF_SOURCE_BYTES) + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return { bytes: bytes.subarray(0, filled), missing: false, partial: filled < info.size };
  } catch (error) { return { missing: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
  finally { await file?.close().catch(() => {}); }
}

const changeResult = (text: string, shown: string, changes: readonly CompletedWriteChange[], cwd: string, withDiff: boolean): ToolResult =>
  ({ isError: false, content: [{ type: "text", text }], host: { summary: shown, status: "ok", ...changeHostData(changes, cwd, withDiff) } });

/** Creates or overwrites one file, creating parent directories (docs/tool-ux-design.md §4.2). */
export async function writeFileTool(args: { path: string; content: string }, context: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(context.cwd, args.path);
  const shown = displayPath(path, context.cwd);
  try {
    const before = await writeSnapshot(path);
    await mkdir(dirname(path), { recursive: true });
    const after = Buffer.from(args.content, "utf8");
    await writeFile(path, after);
    const change: CompletedWriteChange = { path, kind: before.missing ? "added" : "modified", overwritten: !before.missing,
      ...(before.bytes ? { before: before.bytes } : !before.missing ? { beforeUnavailable: true } : {}),
      ...(before.partial ? { beforePartial: true } : {}), after };
    await publishWriteChanges(context, [change]);
    return changeResult(`Wrote ${after.length.toLocaleString("en-US")} bytes to ${shown} (${before.missing ? "created" : "overwritten"})`,
      shown, [change], context.cwd, false);
  } catch (error) {
    const code = errorCode(error, "write_error");
    return { ...errorResult(code, `cannot write ${shown}: ${code}`), host: { summary: shown, status: "error" } };
  }
}

export interface EditFileArgs { path: string; old_string: string; new_string: string; replace_all?: boolean }

/** Start offsets of the non-overlapping occurrences of `needle`. */
function occurrences(source: Buffer, needle: Buffer): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** Start offsets of every occurrence of `needle`, overlapping ones included. */
function matchStarts(source: Buffer, needle: Buffer): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** The first lines where an ambiguous old_string starts, so the model can add context that tells them apart. */
function matchLines(source: Buffer, starts: readonly number[]): string {
  const shown: string[] = [];
  let line = 1;
  let from = 0;
  let previous = 0;
  for (const at of starts) {
    for (let newline = source.indexOf(10, from); newline >= 0 && newline < at; newline = source.indexOf(10, newline + 1)) line++;
    from = at;
    if (line === previous) continue;
    previous = line;
    const begin = at === 0 ? 0 : source.lastIndexOf(10, at - 1) + 1;
    const end = source.indexOf(10, at);
    const text = source.subarray(begin, end < 0 ? source.length : end).toString("utf8").replace(/\r$/, "");
    shown.push(`${line}│${[...text].slice(0, 200).join("")}`);
    if (shown.length === 3) break;
  }
  return `\nMatching lines:\n${shown.join("\n")}`;
}

/** Replaces bytes, not decoded text, so file bytes that are not valid UTF-8 survive an edit elsewhere in the file. */
function replaceAt(source: Buffer, at: readonly number[], length: number, replacement: Buffer): Buffer {
  const parts: Buffer[] = [];
  let from = 0;
  for (const start of at) { parts.push(source.subarray(from, start), replacement); from = start + length; }
  parts.push(source.subarray(from));
  return Buffer.concat(parts);
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index++) { const gram = text.slice(index, index + 2); grams.set(gram, (grams.get(gram) ?? 0) + 1); }
  return grams;
}

/** Up to three file lines most like the first line of `needle`, so a failed edit can be retried. */
function nearestLines(text: string, needle: string): string {
  const target = needle.split("\n").map((line) => line.trim()).find(Boolean);
  const lines = text.split("\n");
  if (!target || target.length < 3 || lines.length > 50_000) return "";
  const wanted = bigrams(target);
  const size = target.length - 1;
  const scored = lines.map((line, index) => {
    const grams = bigrams(line.trim());
    let common = 0;
    for (const [gram, count] of grams) common += Math.min(count, wanted.get(gram) ?? 0);
    return { index, line, score: (2 * common) / (size + Math.max(0, line.trim().length - 1) || 1) };
  }).filter((item) => item.score >= 0.5).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3)
    .sort((a, b) => a.index - b.index);
  return scored.length ? `\nNearest lines:\n${scored.map((item) => `${item.index + 1}│${[...item.line.replace(/\r$/, "")].slice(0, 200).join("")}`).join("\n")}` : "";
}

/** Replaces one exact occurrence of `old_string`, or all of them with `replace_all` (docs/tool-ux-design.md §4.2). */
export async function editFileTool(args: EditFileArgs, context: ToolContext): Promise<ToolResult> {
  const path = resolveToolPath(context.cwd, args.path);
  const shown = displayPath(path, context.cwd);
  const failed = (code: string, message: string): ToolResult => ({ ...errorResult(code, message), host: { summary: shown, status: "error" } });
  let source: Buffer;
  try { source = await readFile(path); }
  catch (error) {
    const code = errorCode(error, "file_error");
    return failed(code, code === "ENOENT" ? `${shown} does not exist; create it with write_file` : `cannot read ${shown}: ${code}`);
  }
  if (source.subarray(0, 8192).includes(0)) return failed("binary_file", `${shown} is binary; edit_file changes text files`);
  let oldBytes = Buffer.from(args.old_string, "utf8");
  let newBytes = Buffer.from(args.new_string, "utf8");
  let found = occurrences(source, oldBytes);
  // A file with CRLF endings matches an old_string written with LF; the replacement keeps the file's endings.
  if (!found.length && args.old_string.includes("\n") && !args.old_string.includes("\r") && source.includes("\r\n")) {
    const crlf = Buffer.from(args.old_string.replace(/\n/g, "\r\n"), "utf8");
    const matches = occurrences(source, crlf);
    if (matches.length) { oldBytes = crlf; newBytes = Buffer.from(args.new_string.replace(/\r?\n/g, "\r\n"), "utf8"); found = matches; }
  }
  const count = found.length;
  if (!count) return failed("edit_not_found", `old_string not found in ${shown}${nearestLines(source.toString("utf8"), args.old_string)}`);
  // Uniqueness counts every start, overlapping ones too: "aa" in "aaa" is ambiguous. replace_all replaces non-overlapping matches.
  const starts = matchStarts(source, oldBytes);
  if (starts.length > 1 && !args.replace_all) {
    return failed("edit_not_unique", `old_string matches ${starts.length} times in ${shown}; add surrounding lines to make it unique or set replace_all`
      + matchLines(source, starts));
  }
  try {
    const after = replaceAt(source, found, oldBytes.length, newBytes);
    await writeFile(path, after);
    const change: CompletedWriteChange = { path, kind: "modified", before: source, after };
    await publishWriteChanges(context, [change]);
    const result = changeResult("", shown, [change], context.cwd, true);
    const file = result.host!.files![0]!;
    const counts = file.added === undefined ? "" : ` (+${file.added} −${file.removed} lines)`;
    return { ...result, content: [{ type: "text", text: `Edited ${shown}: ${count} replacement${count === 1 ? "" : "s"}${counts}` }] };
  } catch (error) {
    const code = errorCode(error, "write_error");
    return failed(code, `cannot write ${shown}: ${code}`);
  }
}

const LETTERS: Record<CompletedWriteChange["kind"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** The patch dialect of file-patch.ts as its own tool: one line per changed file (docs/tool-ux-design.md §4.2). */
export async function applyPatchTool(args: { patch: string }, context: ToolContext): Promise<ToolResult> {
  let parsed;
  try { parsed = parseFilePatch(args.patch, context.cwd); }
  catch (error) { return { ...errorResult("invalid_patch", error instanceof Error ? error.message : "invalid patch"), host: { status: "error" } }; }
  const completed: CompletedWriteChange[] = [];
  // The engine's indexed rows are only read here, so they get room regardless of the model-facing budget.
  const applied = await applyFilePatch(parsed, { maxOutputBytes: 1024 * 1024, ...(context.signal ? { signal: context.signal } : {}),
    onCompleted: async (change) => { completed.push(change); await publishWriteChanges(context, [change]); } });
  const rows = applied.content[0]?.type === "json" ? (applied.content[0].value as { results?: Array<Record<string, unknown>> }).results : undefined;
  const host = { summary: `${parsed.changes.length} file${parsed.changes.length === 1 ? "" : "s"}`, status: applied.isError ? "error" as const : "ok" as const,
    ...changeHostData(completed, context.cwd, true) };
  if (!rows) return { ...applied, host };
  const lines = completed.map((change, index) => {
    const file = host.files![index]!;
    return `${LETTERS[change.kind]} ${file.path}${file.destination ? ` → ${file.destination}` : ""}${file.added === undefined ? "" : ` (+${file.added} −${file.removed})`}`;
  });
  for (const row of rows) if (row.status !== "ok") lines.push(`${row.status === "skipped" ? "skipped" : "failed"} ${String(row.path)}: ${String(row.error ?? row.status)}`);
  return { isError: applied.isError, ...(applied.code ? { code: applied.code } : {}), content: [{ type: "text", text: lines.join("\n") || "No changes." }], host };
}

export const BASH_DEFAULT_TIMEOUT_MS = 120000;
export const BASH_MAX_TIMEOUT_MS = 600000;
/** Room kept beside the output for the status line and a clamp note. */
const BASH_STATUS_RESERVE = 256;
const BACKGROUND_IGNORED = "[ignored run_in_background: background jobs need the process tool; ran in the foreground]";

export interface BashArgs { command: string; timeout?: number; description?: string; workdir?: string; run_in_background?: boolean;
  env_refs?: Record<string, string> }

function seconds(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

/**
 * One Bash or PowerShell command (docs/tool-ux-design.md §4.2): the output in production order, then one status line
 * such as `[exit 0 · 1.2s]`. A nonzero exit is not an error; a timeout or abort is, and stops the process group.
 */
export function shellTool(kind: ShellKind): (args: BashArgs, context: ToolContext) => Promise<ToolResult> {
  return (args, context) => runShellTool(kind, args, context);
}

/** One Bash command; see shellTool. */
export const bashTool = shellTool("bash");

async function runShellTool(kind: ShellKind, args: BashArgs, context: ToolContext): Promise<ToolResult> {
  const cwd = args.workdir === undefined ? context.cwd : resolveToolPath(context.cwd, args.workdir);
  const requested = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(requested, BASH_MAX_TIMEOUT_MS);
  const summary = utf8Prefix(args.command.split("\n", 1)[0]!, 200).text;
  const host = (status: NonNullable<NonNullable<ToolResult["host"]>["status"]>, extra: NonNullable<ToolResult["host"]> = {}): NonNullable<ToolResult["host"]> =>
    ({ summary, status, ...(args.description ? { description: args.description } : {}), ...extra });
  let bindings: Record<string, string> | undefined;
  if (args.env_refs && Object.keys(args.env_refs).length) {
    if (!context.vars) return { ...errorResult("vars_unavailable", "variable services are unavailable"), host: host("error") };
    try {
      context.vars.validateEnvRefs(args.env_refs);
      bindings = await context.vars.resolveEnv(args.env_refs, { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_env_refs_invalid";
      return { ...errorResult(code, error instanceof Error ? error.message : "invalid variable references"), host: host("error") };
    }
  }
  let activity: ReturnType<CommandActivity["begin"]> | undefined;
  try {
    activity = context.commandActivity?.begin(args.command, cwd, { owner: `builtin/${kind}`, ...(args.description ? { label: args.description } : {}), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}) });
  } catch { /* UI persistence cannot change Bash execution. */ }
  const started = performance.now();
  let result: ToolResult;
  try {
    result = await runBash({ shell: kind, command: args.command, cwd, workspace: context.cwd, maxOutputBytes: Math.max(0, context.maxOutputBytes - BASH_STATUS_RESERVE),
      timeoutMs: timeout,
      ...(activity ? { onOutput: activity.output } : {}),
      ...(bindings ? { env: mergeEnv(process.env, bindings) } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(kind === "bash" && context.bashPath ? { bashPath: context.bashPath } : {}),
    });
  } catch (error) {
    result = errorResult(`${kind}_error`, (error as Error).message);
  }
  try { activity?.finish(result); } catch { /* UI persistence cannot change the completed Bash outcome. */ }
  const durationMs = Math.round(performance.now() - started);
  if ([`${kind}_spawn_error`, `${kind}_error`, `${kind}_unavailable`].includes(result.code ?? "")) return { ...result, host: host("error", { durationMs }) };
  const aborted = result.code === "aborted" || context.signal?.aborted === true;
  // Windows stops the command's whole job at once rather than signalling a process group.
  const stopped = process.platform === "win32" ? "process tree stopped" : "process group stopped";
  const status = aborted ? `[aborted after ${seconds(durationMs)}; ${stopped}]`
    : result.timedOut ? `[timed out after ${timeout / 1000}s; ${stopped}]`
      : result.exitCode === null || result.exitCode === undefined ? `[killed by ${result.signal ?? "signal"} · ${seconds(durationMs)}]`
        : `[exit ${result.exitCode} · ${seconds(durationMs)}]`;
  // Reached with run_in_background only when the call was not handed to the process tool.
  const notes = [...(requested > BASH_MAX_TIMEOUT_MS ? [`[timeout clamped to ${BASH_MAX_TIMEOUT_MS} ms]`] : []),
    ...(args.run_in_background === true ? [BACKGROUND_IGNORED] : [])];
  return { ...result, content: [...result.content, { type: "text", text: [status, ...notes].join("\n") }],
    host: host(aborted ? "cancelled" : result.timedOut ? "timeout" : "ok", { durationMs,
      exitCode: result.exitCode ?? null, signal: result.signal ?? null,
      ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath, ...(result.fullOutputCapped ? { fullOutputCapped: true } : {}) } : {}) }) };
}
