import { writeFileTool, type ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  const unexpected = Object.keys(args).find((key) => key !== "operations");
  if (unexpected !== undefined) return `unknown write_file property ${JSON.stringify(unexpected)}; use {"operations":[{"path":"...","mode":"overwrite","content":"..."}]}`;
  if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 16) return "operations must contain 1 to 16 entries";
  const fields: Record<string, readonly string[]> = {
    overwrite: ["path", "mode", "content"], append: ["path", "mode", "content"],
    replace_text: ["path", "mode", "old_text", "new_text"],
    replace_lines: ["path", "mode", "start_line", "end_line", "content", "expected_sha256"],
  };
  for (const [index, raw] of args.operations.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `operations[${index}] must be an object`;
    const op = raw as Record<string, unknown>;
    if (typeof op.path !== "string" || !op.path) return `operations[${index}].path must be a nonempty string`;
    if (typeof op.mode !== "string" || !Object.hasOwn(fields, op.mode)) return `operations[${index}].mode is invalid`;
    const allowed = fields[op.mode]!;
    if (Object.keys(op).some((key) => !allowed.includes(key))) return `operations[${index}] has an invalid field for ${op.mode}`;
    for (const key of allowed) if (!Object.hasOwn(op, key)) return `operations[${index}] missing ${key}`;
    if (allowed.includes("content") && typeof op.content !== "string") return `operations[${index}].content must be a string`;
    if (op.mode === "replace_text" && (typeof op.old_text !== "string" || !op.old_text || typeof op.new_text !== "string")) {
      return `operations[${index}] requires nonempty old_text and string new_text`;
    }
    if (op.mode === "replace_lines") {
      if (!Number.isSafeInteger(op.start_line) || !Number.isSafeInteger(op.end_line)
        || (op.start_line as number) < 1 || (op.end_line as number) < (op.start_line as number)
        || (op.end_line as number) > 2147483647) return `operations[${index}] has invalid line range`;
      if (typeof op.expected_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(op.expected_sha256)) {
        return `operations[${index}].expected_sha256 must be lowercase SHA-256`;
      }
    }
  }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return writeFileTool(args as Parameters<typeof writeFileTool>[0], context);
}
