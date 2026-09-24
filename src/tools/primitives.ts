import { open, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { runBash } from "./process.js";
import { errorResult, indexedResult, indexedResultFits, textResult, type IndexedResult } from "./results.js";
import type { ToolResult } from "./types.js";

export interface ToolContext {
  cwd: string;
  maxOutputBytes: number;
  autoApprove?: boolean;
  approve?: (name: string, args: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string) => boolean | Promise<boolean>;
  toolCallId?: string;
  onStart?: (name: string, args: Record<string, unknown>) => void;
  whitelist?: readonly string[];
  signal?: AbortSignal;
  bashPath?: string;
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

export async function writeFileTool(args: { path: string; content: string }, context: ToolContext): Promise<ToolResult> {
  const path = resolve(context.cwd, args.path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, "utf8");
    return textResult(`wrote ${path}`, context.maxOutputBytes);
  } catch (error) {
    return errorResult("write_error", `cannot write ${path}: ${(error as Error).message}`);
  }
}

export async function bashTool(args: { command: string; timeout_ms?: number }, context: ToolContext): Promise<ToolResult> {
  return runBash({
    command: args.command,
    cwd: context.cwd,
    maxOutputBytes: context.maxOutputBytes,
    ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.bashPath ? { bashPath: context.bashPath } : {}),
  });
}
