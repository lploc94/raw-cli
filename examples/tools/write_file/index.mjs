// src/tools/primitives.ts
import { open, mkdir, writeFile, readFile, appendFile } from "fs/promises";
import { createHash } from "crypto";
import { dirname, resolve } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
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

// src/tools/primitives.ts
function selectedHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function selectedLineSpan(bytes, startLine, endLine) {
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
  return void 0;
}
async function writeFileTool(args, context) {
  const rows = args.operations.map((op, index) => ({ index, path: op.path, mode: op.mode, status: "error", error: "x".repeat(120) }));
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
        if (start === 0 && source.subarray(0, 3).equals(Buffer.from([239, 187, 191])) && !replacement.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) {
          replacement = Buffer.concat([source.subarray(0, 3), replacement]);
        }
        if (op.content.length && end < source.length && replacement[replacement.length - 1] !== 10) {
          const boundary = source[end - 1] === 10 ? source[end - 2] === 13 ? Buffer.from("\r\n") : Buffer.from("\n") : Buffer.from("\n");
          replacement = Buffer.concat([replacement, boundary]);
        }
        await writeFile(path, Buffer.concat([source.subarray(0, start), replacement, source.subarray(end)]));
        bytesWritten = replacement.length;
      }
      rows[index] = { index, path: op.path, mode: op.mode, status: "ok", bytes_written: bytesWritten };
    } catch (error) {
      const code = error.code ?? error.message;
      rows[index] = { index, path: op.path, mode: op.mode, status: "error", error: /^[A-Za-z0-9_]+$/.test(code) ? code : "write_error" };
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}

// src/tools/bundled/write_file/index.ts
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  const unexpected = Object.keys(args).find((key) => key !== "operations");
  if (unexpected !== void 0) return `unknown write_file property ${JSON.stringify(unexpected)}; use {"operations":[{"path":"...","mode":"overwrite","content":"..."}]}`;
  if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 16) return "operations must contain 1 to 16 entries";
  const fields = {
    overwrite: ["path", "mode", "content"],
    append: ["path", "mode", "content"],
    replace_text: ["path", "mode", "old_text", "new_text"],
    replace_lines: ["path", "mode", "start_line", "end_line", "content", "expected_sha256"]
  };
  for (const [index, raw] of args.operations.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `operations[${index}] must be an object`;
    const op = raw;
    if (typeof op.path !== "string" || !op.path) return `operations[${index}].path must be a nonempty string`;
    if (typeof op.mode !== "string" || !Object.hasOwn(fields, op.mode)) return `operations[${index}].mode is invalid`;
    const allowed = fields[op.mode];
    if (Object.keys(op).some((key) => !allowed.includes(key))) return `operations[${index}] has an invalid field for ${op.mode}`;
    for (const key of allowed) if (!Object.hasOwn(op, key)) return `operations[${index}] missing ${key}`;
    if (allowed.includes("content") && typeof op.content !== "string") return `operations[${index}].content must be a string`;
    if (op.mode === "replace_text" && (typeof op.old_text !== "string" || !op.old_text || typeof op.new_text !== "string")) {
      return `operations[${index}] requires nonempty old_text and string new_text`;
    }
    if (op.mode === "replace_lines") {
      if (!Number.isSafeInteger(op.start_line) || !Number.isSafeInteger(op.end_line) || op.start_line < 1 || op.end_line < op.start_line || op.end_line > 2147483647) return `operations[${index}] has invalid line range`;
      if (typeof op.expected_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(op.expected_sha256)) {
        return `operations[${index}].expected_sha256 must be lowercase SHA-256`;
      }
    }
  }
  return void 0;
}
async function handler(args, context) {
  return writeFileTool(args, context);
}
export {
  handler,
  validateArgs
};
