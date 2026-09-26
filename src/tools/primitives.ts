import type { VariableContext } from "../vars/contract.js";
import { open, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { runBash } from "./process.js";
import { errorResult, indexedResult, indexedResultFits, utf8Prefix, type IndexedResult } from "./results.js";
import type { ToolResult } from "./types.js";
import type { SelectedSkill } from "../skills/contract.js";

export interface ToolContext {
  vars?: VariableContext;
  cwd: string;
  maxOutputBytes: number;
  autoApprove?: boolean;
  approve?: (name: string, args: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string) => boolean | Promise<boolean>;
  toolCallId?: string;
  onStart?: (name: string, args: Record<string, unknown>) => void;
  whitelist?: readonly string[];
  signal?: AbortSignal;
  bashPath?: string;
  skills?: readonly SelectedSkill[];
}

export interface ReadFileSpec {
  path: string;
  start_line?: number;
  end_line?: number;
  max_lines?: number;
  max_bytes?: number;
}

function selectedHash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function readFileTool(args: { files: ReadFileSpec[] }, context: ToolContext): Promise<ToolResult> {
  const rows: IndexedResult[] = args.files.map((file, index) => ({ index, path: file.path, status: "budget_exhausted" }));
  if (!indexedResultFits(rows, context.maxOutputBytes)) return errorResult("output_budget_too_small", "read batch status exceeds output budget");
  const reserve = (index: number): IndexedResult => ({ index, path: args.files[index]!.path, status: "error", error: "x".repeat(160) });
  if (!indexedResultFits(rows.map((row, index) => index ? reserve(index) : row), context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "read batch outcomes exceed output budget");
  }
  const put = (index: number, candidate: IndexedResult): boolean => {
    const copy = [...rows];
    copy[index] = candidate;
    if (!indexedResultFits(copy.map((row, at) => at > index ? reserve(at) : row), context.maxOutputBytes)) return false;
    rows[index] = candidate;
    return true;
  };
  const itemFits = (file: ReadFileSpec, candidate: IndexedResult): boolean =>
    file.max_bytes === undefined || Buffer.byteLength(JSON.stringify(candidate), "utf8") <= file.max_bytes;
  for (const [index, file] of args.files.entries()) {
    if (context.signal?.aborted) { put(index, { index, path: file.path, status: "skipped", error: "aborted" }); continue; }
    const path = resolve(context.cwd, file.path);
    try {
      const handle = await open(path, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) { put(index, { index, path: file.path, status: "error", error: "not a regular file" }); continue; }
        const ranged = file.start_line !== undefined || file.end_line !== undefined || file.max_lines !== undefined;
        if (!ranged && stat.size <= Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes)) {
          const buffer = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead === stat.size) {
            const selected = buffer.subarray(0, bytesRead);
            const count = bytesRead === 0 ? 0 : selected.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0)
              + (selected[bytesRead - 1] === 10 ? 0 : 1);
            const candidate: IndexedResult = { index, path: file.path, status: "ok", text: selected.toString("utf8"),
              start_line: count ? 1 : 0, end_line: count, eof: true, sha256: selectedHash(selected) };
            if (itemFits(file, candidate) && put(index, candidate)) continue;
          }
        }
        const start = file.start_line ?? 1;
        const requestedEnd = file.end_line ?? (file.max_lines !== undefined ? start + file.max_lines - 1 : Infinity);
        const itemByteLimit = Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes);
        const accepted: Buffer[] = [];
        let acceptedBytes = 0;
        let deferred: Buffer[] = [];
        let deferredBytes = 0;
        let actualEnd = start - 1;
        let currentLine = 1;
        let position = 0;
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let stopped = false;
        let budgetStop = false;
        let reachedEof = false;
        const acceptLine = (line: number): boolean => {
          const raw = Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          const nextBytes = Buffer.concat([...accepted, ...deferred, raw], acceptedBytes + deferredBytes + raw.length);
          const complete = line >= requestedEnd || position === stat.size;
          const candidate: IndexedResult = { index, path: file.path, status: complete ? "ok" : "partial", text: nextBytes.toString("utf8"),
            start_line: start, end_line: line, eof: position === stat.size,
            ...(!complete ? { next_line: line + 1 } : {}), sha256: selectedHash(nextBytes) };
          if (nextBytes.length > itemByteLimit) {
            budgetStop = true;
            stopped = true;
            return false;
          }
          const fits = itemFits(file, candidate) && indexedResultFits(rows.map((row, at) =>
            at === index ? candidate : at > index ? reserve(at) : row), context.maxOutputBytes);
          if (fits) {
            accepted.push(...deferred, raw);
            acceptedBytes += deferredBytes + raw.length;
            deferred = [];
            deferredBytes = 0;
            actualEnd = line;
          } else if (complete) {
            budgetStop = true;
            stopped = true;
            return false;
          } else {
            deferred.push(raw);
            deferredBytes += raw.length;
          }
          return true;
        };
        const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
        scan: for await (const rawChunk of stream) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          let cursor = 0;
          while (cursor < chunk.length) {
            const newline = chunk.indexOf(10, cursor);
            const end = newline < 0 ? chunk.length : newline + 1;
            const segment = chunk.subarray(cursor, end);
            position += segment.length;
            if (currentLine >= start) {
              pending.push(segment);
              pendingBytes += segment.length;
              if (acceptedBytes + deferredBytes + pendingBytes > itemByteLimit || acceptedBytes + deferredBytes + pendingBytes > context.maxOutputBytes) {
                budgetStop = true;
                stopped = true;
                break scan;
              }
            }
            cursor = end;
            if (newline < 0) continue;
            if (currentLine >= start && !acceptLine(currentLine)) break scan;
            if (currentLine >= requestedEnd) {
              reachedEof = position === stat.size;
              stopped = true;
              break scan;
            }
            currentLine++;
          }
        }
        if (!stopped) {
          if (pendingBytes > 0 && currentLine >= start) acceptLine(currentLine);
          reachedEof = !budgetStop;
        }
        const selected = Buffer.concat(accepted, acceptedBytes);
        const candidate: IndexedResult = budgetStop || deferredBytes
          ? { index, path: file.path, status: acceptedBytes ? "partial" : "line_too_large", text: selected.toString("utf8"),
            start_line: start, end_line: actualEnd, eof: false, next_line: actualEnd + 1,
            ...(acceptedBytes ? { sha256: selectedHash(selected) } : {}) }
          : { index, path: file.path, status: "ok", text: selected.toString("utf8"), start_line: start,
            end_line: actualEnd, eof: reachedEof, sha256: selectedHash(selected) };
        if (!itemFits(file, candidate) && candidate.status === "ok") {
          put(index, { index, path: file.path, status: "budget_exhausted" });
        } else {
          put(index, candidate);
        }
      } finally { await handle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      put(index, { index, path: file.path, status: "error", error: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "file_error" });
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => !["ok", "partial"].includes(row.status)));
}

export type WriteOperation =
  | { path: string; mode: "overwrite"; content: string }
  | { path: string; mode: "append"; content: string }
  | { path: string; mode: "replace_text"; old_text: string; new_text: string }
  | { path: string; mode: "replace_lines"; start_line: number; end_line: number; content: string; expected_sha256: string };

function selectedLineSpan(bytes: Buffer, startLine: number, endLine: number): { start: number; end: number } | undefined {
  let start = 0;
  let line = 1;
  let selectedStart = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    if (line === startLine) selectedStart = start;
    if (line === endLine) return { start: selectedStart, end };
    start = end;
    line++;
  }
  return undefined;
}

export async function writeFileTool(args: { operations: WriteOperation[] }, context: ToolContext): Promise<ToolResult> {
  const rows: IndexedResult[] = args.operations.map((op, index) => ({ index, path: op.path, mode: op.mode, status: "error", error: "x".repeat(120) }));
  if (!indexedResultFits(rows, context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "write batch outcomes exceed output budget");
  }
  for (const [index, op] of args.operations.entries()) {
    if (context.signal?.aborted) {
      rows[index] = { index, path: op.path, mode: op.mode, status: "skipped", error: "aborted" };
      continue;
    }
    const path = resolve(context.cwd, op.path);
    try {
      let bytesWritten = 0;
      if (op.mode === "overwrite" || op.mode === "append") {
        await mkdir(dirname(path), { recursive: true });
        if (op.mode === "overwrite") await writeFile(path, op.content, "utf8");
        else await appendFile(path, op.content, "utf8");
        bytesWritten = Buffer.byteLength(op.content);
      } else if (op.mode === "replace_text") {
        const source = await readFile(path);
        const oldBytes = Buffer.from(op.old_text, "utf8");
        const first = source.indexOf(oldBytes);
        if (first < 0) throw new Error("text_not_found");
        if (source.indexOf(oldBytes, first + 1) >= 0) throw new Error("text_not_unique");
        const replacement = Buffer.from(op.new_text, "utf8");
        await writeFile(path, Buffer.concat([source.subarray(0, first), replacement, source.subarray(first + oldBytes.length)]));
        bytesWritten = replacement.length;
      } else {
        const source = await readFile(path);
        const span = selectedLineSpan(source, op.start_line, op.end_line);
        if (!span) throw new Error("line_out_of_range");
        const { start, end } = span;
        if (selectedHash(source.subarray(start, end)) !== op.expected_sha256) throw new Error("guard_mismatch");
        let replacement = Buffer.from(op.content, "utf8");
        if (start === 0 && source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
          && !replacement.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
          replacement = Buffer.concat([source.subarray(0, 3), replacement]);
        }
        if (op.content.length && end < source.length && replacement[replacement.length - 1] !== 10) {
          const boundary = source[end - 1] === 10 ? (source[end - 2] === 13 ? Buffer.from("\r\n") : Buffer.from("\n")) : Buffer.from("\n");
          replacement = Buffer.concat([replacement, boundary]);
        }
        await writeFile(path, Buffer.concat([source.subarray(0, start), replacement, source.subarray(end)]));
        bytesWritten = replacement.length;
      }
      rows[index] = { index, path: op.path, mode: op.mode, status: "ok", bytes_written: bytesWritten };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      rows[index] = { index, path: op.path, mode: op.mode, status: "error", error: /^[A-Za-z0-9_]+$/.test(code) ? code : "write_error" };
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}

export async function bashTool(args: { commands: Array<{ command: string; timeout_ms?: number; env_refs?: Record<string, string> }> }, context: ToolContext): Promise<ToolResult> {
  const reserve = (index: number): IndexedResult => ({ index, status: "error", exit_code: 2147483647,
    signal: "SIGKILL", timed_out: true, truncated: true, stdout: "", stderr: "", observed_bytes: 2147483647,
    error: "x".repeat(80) });
  const rows: IndexedResult[] = args.commands.map((_, index) => reserve(index));
  if (!indexedResultFits(rows, context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "bash batch outcomes exceed output budget");
  }
  for (const command of args.commands) if (command.env_refs && Object.keys(command.env_refs).length) {
    if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
    try { context.vars.validateEnvRefs(command.env_refs); }
    catch (error) { return errorResult("var_env_refs_invalid", error instanceof Error ? error.message : "invalid variable references"); }
  }
  let stopped = false;
  let stopReason = "prior_timeout";
  for (const [index, command] of args.commands.entries()) {
    if (stopped || context.signal?.aborted) {
      rows[index] = { index, status: "skipped", error: context.signal?.aborted ? "aborted" : stopReason };
      continue;
    }
    const serialized = Buffer.byteLength(JSON.stringify({ results: rows }), "utf8");
    const share = Math.max(0, Math.floor((context.maxOutputBytes - serialized) / (args.commands.length - index)));
    const reservedItemBytes = Buffer.byteLength(JSON.stringify(rows[index]), "utf8");
    let result: ToolResult;
    let bindings: Record<string, string> | undefined;
    try {
      if (command.env_refs && Object.keys(command.env_refs).length) bindings = await context.vars!.resolveEnv(command.env_refs, { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_error";
      rows[index] = { index, status: context.signal?.aborted ? "aborted" : "error", error: code };
      stopped = true; stopReason = "prior_var_error"; continue;
    }
    try {
      result = await runBash({ command: command.command, cwd: context.cwd, maxOutputBytes: share,
        ...(bindings ? { env: { ...process.env, ...bindings } } : {}),
        ...(command.timeout_ms !== undefined ? { timeoutMs: command.timeout_ms } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.bashPath ? { bashPath: context.bashPath } : {}),
      });
    } catch (error) {
      result = errorResult("bash_error", (error as Error).message);
    }
    let stdout = result.content.flatMap((item) => item.type === "text" && item.channel === "stdout" ? [item.text] : []).join("");
    let stderr = result.content.flatMap((item) => item.type === "text" && item.channel === "stderr" ? [item.text] : []).join("");
    const status = result.code === "aborted" || context.signal?.aborted ? "aborted"
      : result.code === "timeout" || result.timedOut ? "timeout" : result.isError ? "error" : "ok";
    const candidate = (): IndexedResult => ({ index, status, exit_code: result.exitCode ?? null,
      signal: result.signal ?? null, timed_out: result.timedOut ?? false,
      truncated: Boolean(result.truncated || stdout !== originalStdout || stderr !== originalStderr),
      stdout, stderr, observed_bytes: result.observedBytes ?? 0,
      ...(status === "error" ? { error: result.code ?? "bash_error" } : {}) });
    const originalStdout = stdout;
    const originalStderr = stderr;
    const fits = () => {
      const check = [...rows];
      check[index] = candidate();
      const addedBytes = Buffer.byteLength(JSON.stringify(check[index]), "utf8") - reservedItemBytes;
      return addedBytes <= share && indexedResultFits(check, context.maxOutputBytes);
    };
    while (!fits() && (stdout || stderr)) {
      if (Buffer.byteLength(stdout) >= Buffer.byteLength(stderr) && stdout) stdout = utf8Prefix(stdout, Math.floor(Buffer.byteLength(stdout) / 2)).text;
      else stderr = utf8Prefix(stderr, Math.floor(Buffer.byteLength(stderr) / 2)).text;
    }
    rows[index] = fits() ? candidate() : { index, status: "error", error: "result_budget_exhausted" };
    if (status === "aborted" || status === "timeout") stopped = true;
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}
