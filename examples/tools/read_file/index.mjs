// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "path";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
var HOST_CONTENT_BYTES = 1024 * 1024;
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}
function indexedResultFits(results, maxOutputBytes) {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8") <= maxOutputBytes;
}
function indexedResult(results, maxOutputBytes, isError) {
  if (!indexedResultFits(results, maxOutputBytes)) return errorResult("output_budget_too_small", "batch status exceeds output budget");
  return { isError, content: [{ type: "json", value: { results } }] };
}

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

// src/panels/contract.ts
var PANEL_LIMITS = {
  panelsPerTool: 4,
  actionsPerPanel: 8,
  panelsPerSession: 16,
  documentBytes: 64 * 1024,
  blocks: 20,
  items: 200,
  steps: 30,
  checklistDepth: 3,
  updatesPerCall: 200,
  receiptBytes: 1024,
  reminderBytes: 2 * 1024,
  reminderTotalBytes: 8 * 1024,
  markdownBytes: 16 * 1024,
  fallbackBytes: 4 * 1024,
  contextSummaryBytes: 2048
};

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile, appendFile, stat } from "fs/promises";
import { createHash as createHash2 } from "crypto";
import { dirname as dirname2, resolve as resolve2 } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/primitives.ts
function selectedHash(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
async function readFileTool(args, context) {
  const rows = args.files.map((file, index) => ({ index, path: file.path, status: "budget_exhausted" }));
  if (!indexedResultFits(rows, context.maxOutputBytes)) return errorResult("output_budget_too_small", "read batch status exceeds output budget");
  const reserve = (index) => ({ index, path: args.files[index].path, status: "error", error: "x".repeat(160) });
  if (!indexedResultFits(rows.map((row, index) => index ? reserve(index) : row), context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "read batch outcomes exceed output budget");
  }
  const put = (index, candidate) => {
    const copy = [...rows];
    copy[index] = candidate;
    if (!indexedResultFits(copy.map((row, at) => at > index ? reserve(at) : row), context.maxOutputBytes)) return false;
    rows[index] = candidate;
    return true;
  };
  const itemFits = (file, candidate) => file.max_bytes === void 0 || Buffer.byteLength(JSON.stringify(candidate), "utf8") <= file.max_bytes;
  for (const [index, file] of args.files.entries()) {
    if (context.signal?.aborted) {
      put(index, { index, path: file.path, status: "skipped", error: "aborted" });
      continue;
    }
    const path = resolve2(context.cwd, file.path);
    try {
      const handle = await open2(path, "r");
      try {
        const stat2 = await handle.stat();
        if (!stat2.isFile()) {
          put(index, { index, path: file.path, status: "error", error: "not a regular file" });
          continue;
        }
        const ranged = file.start_line !== void 0 || file.end_line !== void 0 || file.max_lines !== void 0;
        if (!ranged && stat2.size <= Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes)) {
          const buffer = Buffer.alloc(stat2.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead === stat2.size) {
            const selected2 = buffer.subarray(0, bytesRead);
            const count = bytesRead === 0 ? 0 : selected2.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0) + (selected2[bytesRead - 1] === 10 ? 0 : 1);
            const candidate2 = {
              index,
              path: file.path,
              status: "ok",
              text: selected2.toString("utf8"),
              start_line: count ? 1 : 0,
              end_line: count,
              eof: true,
              sha256: selectedHash(selected2)
            };
            if (itemFits(file, candidate2) && put(index, candidate2)) continue;
          }
        }
        const start = file.start_line ?? 1;
        const requestedEnd = file.end_line ?? (file.max_lines !== void 0 ? start + file.max_lines - 1 : Infinity);
        const itemByteLimit = Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes);
        const accepted = [];
        let acceptedBytes = 0;
        let deferred = [];
        let deferredBytes = 0;
        let actualEnd = start - 1;
        let currentLine = 1;
        let position = 0;
        let pending = [];
        let pendingBytes = 0;
        let stopped = false;
        let budgetStop = false;
        let reachedEof = false;
        const acceptLine = (line) => {
          const raw = Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          const nextBytes = Buffer.concat([...accepted, ...deferred, raw], acceptedBytes + deferredBytes + raw.length);
          const complete = line >= requestedEnd || position === stat2.size;
          const candidate2 = {
            index,
            path: file.path,
            status: complete ? "ok" : "partial",
            text: nextBytes.toString("utf8"),
            start_line: start,
            end_line: line,
            eof: position === stat2.size,
            ...!complete ? { next_line: line + 1 } : {},
            sha256: selectedHash(nextBytes)
          };
          if (nextBytes.length > itemByteLimit) {
            budgetStop = true;
            stopped = true;
            return false;
          }
          const fits = itemFits(file, candidate2) && indexedResultFits(rows.map((row, at) => at === index ? candidate2 : at > index ? reserve(at) : row), context.maxOutputBytes);
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
              reachedEof = position === stat2.size;
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
        const candidate = budgetStop || deferredBytes ? {
          index,
          path: file.path,
          status: acceptedBytes ? "partial" : "line_too_large",
          text: selected.toString("utf8"),
          start_line: start,
          end_line: actualEnd,
          eof: false,
          next_line: actualEnd + 1,
          ...acceptedBytes ? { sha256: selectedHash(selected) } : {}
        } : {
          index,
          path: file.path,
          status: "ok",
          text: selected.toString("utf8"),
          start_line: start,
          end_line: actualEnd,
          eof: reachedEof,
          sha256: selectedHash(selected)
        };
        if (!itemFits(file, candidate) && candidate.status === "ok") {
          put(index, { index, path: file.path, status: "budget_exhausted" });
        } else {
          put(index, candidate);
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = error.code;
      put(index, { index, path: file.path, status: "error", error: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "file_error" });
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => !["ok", "partial"].includes(row.status)));
}

// src/tools/bundled/read_file/index.ts
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  const unexpected = Object.keys(args).find((key) => key !== "files");
  if (unexpected !== void 0) return `unknown read_file property ${JSON.stringify(unexpected)}; use {"files":[{"path":"..."}]}`;
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 16) return "files must contain 1 to 16 entries";
  for (const [index, raw] of args.files.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `files[${index}] must be an object`;
    const file = raw;
    if (Object.keys(file).some((key) => !["path", "start_line", "end_line", "max_lines", "max_bytes"].includes(key))) return `files[${index}] has an unknown property`;
    if (typeof file.path !== "string" || !file.path) return `files[${index}].path must be a nonempty string`;
    for (const key of ["start_line", "end_line", "max_lines", "max_bytes"]) {
      if (file[key] !== void 0 && (!Number.isSafeInteger(file[key]) || file[key] < 1 || file[key] > 2147483647)) {
        return `files[${index}].${key} must be a positive integer`;
      }
    }
    if (file.end_line !== void 0 && file.max_lines !== void 0) return `files[${index}] cannot combine end_line and max_lines`;
    if (file.end_line !== void 0 && file.end_line < (file.start_line ?? 1)) return `files[${index}].end_line precedes start_line`;
  }
  return void 0;
}
async function handler(args, context) {
  return readFileTool(args, context);
}
export {
  handler,
  validateArgs
};
