import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";
import { errorResult } from "../../results.js";

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
  try {
    const value = await context.vars.read(args.name as string, { ...(context.signal ? { signal: context.signal } : {}) });
    if (Buffer.byteLength(JSON.stringify(value)) > context.maxOutputBytes) return errorResult("output_budget_too_small", "variable result exceeds output budget");
    return { isError: false, content: [{ type: "json", value }] };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_error";
    return errorResult(code, error instanceof Error ? error.message : "variable resolution failed");
  }
}
