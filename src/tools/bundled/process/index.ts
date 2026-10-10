import { isAbsolute, resolve } from "node:path";
import type { ToolContext } from "../../primitives.js";
import type { ToolHandlerResult } from "../../types.js";
import { errorResult, utf8Prefix } from "../../results.js";
interface Input { action: "start" | "list" | "status" | "output" | "stop"; command?: string; cwd?: string; label?: string; timeout_ms?: number; env_refs?: Record<string,string>; id?: string; cursor?: number; max_bytes?: number }
export function validateArgs(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
  const args = raw as Input;
  if (!["start","list","status","output","stop"].includes(args.action)) return "unknown process action";
  const allowed = args.action === "start" ? ["action","command","cwd","label","timeout_ms","env_refs"] : args.action === "list" ? ["action"] : args.action === "output" ? ["action","id","cursor","max_bytes"] : ["action","id"];
  if (Object.keys(args).some(key => !allowed.includes(key))) return "unknown field for this process action";
  if (args.action === "start") {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 65536) return "command must be nonempty and at most 65536 characters";
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd || isAbsolute(args.cwd))) return "cwd must be relative to the session";
    if (args.label !== undefined && (typeof args.label !== "string" || !args.label || args.label.length > 200)) return "label must be 1–200 characters";
    if (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 2147483647)) return "timeout_ms is out of range";
    if (args.env_refs !== undefined && (!args.env_refs || typeof args.env_refs !== "object" || Array.isArray(args.env_refs) || Object.entries(args.env_refs).some(([key,value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || !value))) return "env_refs must map environment identifiers to variable names";
  } else if (args.action !== "list" && (typeof args.id !== "string" || !args.id || args.id.length > 128)) return "id is required";
  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) return "invalid cursor";
  if (args.max_bytes !== undefined && (!Number.isSafeInteger(args.max_bytes) || args.max_bytes < 1 || args.max_bytes > 65536)) return "max_bytes must be 1–65536";
  return undefined;
}
export async function handler(raw: unknown, context: ToolContext): Promise<ToolHandlerResult> {
  const invalid = validateArgs(raw); if (invalid) return errorResult("invalid_arguments", invalid);
  if (!context.processes) return errorResult("process_unavailable", "This host has no process supervisor");
  const args = raw as Input;
  try {
    let value: unknown;
    if (args.action === "start") {
      if (context.maxOutputBytes < Buffer.byteLength(JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", state: "starting", createdAt: Number.MAX_SAFE_INTEGER }))) return errorResult("output_budget_too_small", "process start acknowledgement exceeds the output budget");
      let bindings: Record<string,string> | undefined;
      if (args.env_refs && Object.keys(args.env_refs).length) {
        if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
        context.vars.validateEnvRefs(args.env_refs); bindings = await context.vars.resolveEnv(args.env_refs, { ...(context.signal ? { signal: context.signal } : {}) });
      }
      const record = await context.processes.start({ command: args.command!, cwd: resolve(context.cwd, args.cwd ?? "."),
        ...(args.label ? { label: args.label } : {}), ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
        ...(context.signal ? { signal: context.signal } : {}), ...(context.bashPath ? { bashPath: context.bashPath } : {}),
        ...(bindings ? { env: { ...process.env, ...bindings } } : {}) });
      value = { id: record.id, state: record.state, createdAt: record.createdAt };
    } else if (args.action === "list") value = context.processes.list();
    else if (args.action === "status") value = context.processes.status(args.id!);
    else if (args.action === "stop") value = await context.processes.stop(args.id!);
    else {
      const page = context.processes.output(args.id!, args.cursor, Math.min(args.max_bytes ?? 65536, Math.max(1, context.maxOutputBytes)));
      const hadOutput = page.chunks.length > 0;
      // Keep cursor metadata in JSON even when escaped text or chunk envelopes consume the budget.
      while (Buffer.byteLength(JSON.stringify(page)) > context.maxOutputBytes && page.chunks.length) {
        const last = page.chunks.at(-1)!;
        const original = last.text; let low = 0; let high = Buffer.byteLength(original);
        page.truncated = true;
        while (low < high) {
          const middle = Math.floor((low + high + 1) / 2);
          const candidate = utf8Prefix(original, middle);
          last.text = candidate.text; last.end = last.start + candidate.bytes; page.nextCursor = last.end;
          if (Buffer.byteLength(JSON.stringify(page)) <= context.maxOutputBytes) low = middle;
          else high = middle - 1;
        }
        const prefix = utf8Prefix(original, low);
        if (!prefix.bytes) page.chunks.pop();
        else { last.text = prefix.text; last.end = last.start + prefix.bytes; }
        page.nextCursor = page.chunks.at(-1)?.end ?? Math.min(page.cursor, Math.max(args.cursor ?? 0, page.earliestCursor));
        page.truncated = true;
      }
      if (hadOutput && !page.chunks.length) return errorResult("output_budget_too_small", "process output needs enough budget for cursor metadata and one character");
      if (Buffer.byteLength(JSON.stringify(page)) > context.maxOutputBytes) return errorResult("output_budget_too_small", "process output cursor metadata exceeds the output budget");
      value = page;
    }
    return { isError: false, content: [{ type: "json", value }] };
  } catch (error) { const failure = error as Error & {code?:string}; return errorResult(failure.code ?? "process_error", failure.message); }
}
