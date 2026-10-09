import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";
import { errorResult } from "../../results.js";

export async function handler(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const value = { skills: (context.skills ?? []).map(({ name, description }) => ({ name, description })) };
  if (Buffer.byteLength(JSON.stringify(value)) > context.maxOutputBytes) return errorResult("output_budget_too_small", "skill catalog exceeds output budget");
  return { isError: false, content: [{ type: "json", value }] };
}
