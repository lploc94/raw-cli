import { readFileTool, type ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  const unexpected = Object.keys(args).find((key) => key !== "files");
  if (unexpected !== undefined) return `unknown read_file property ${JSON.stringify(unexpected)}; use {"files":[{"path":"..."}]}`;
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 16) return "files must contain 1 to 16 entries";
  for (const [index, raw] of args.files.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `files[${index}] must be an object`;
    const file = raw as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["path", "start_line", "end_line", "max_lines", "max_bytes"].includes(key))) return `files[${index}] has an unknown property`;
    if (typeof file.path !== "string" || !file.path) return `files[${index}].path must be a nonempty string`;
    for (const key of ["start_line", "end_line", "max_lines", "max_bytes"] as const) {
      if (file[key] !== undefined && (!Number.isSafeInteger(file[key]) || (file[key] as number) < 1 || (file[key] as number) > 2147483647)) {
        return `files[${index}].${key} must be a positive integer`;
      }
    }
    if (file.end_line !== undefined && file.max_lines !== undefined) return `files[${index}] cannot combine end_line and max_lines`;
    if (file.end_line !== undefined && (file.end_line as number) < (file.start_line as number | undefined ?? 1)) return `files[${index}].end_line precedes start_line`;
  }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return readFileTool(args as Parameters<typeof readFileTool>[0], context);
}
