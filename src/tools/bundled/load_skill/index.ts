import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";
import { errorResult } from "../../results.js";

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const skill = context.skills?.find((item) => item.name === args.name);
  if (!skill) return { isError: true, code: "unknown_skill", content: [{ type: "text", text: "skill is not selected" }] };
  if (Buffer.byteLength(skill.markdown) > context.maxOutputBytes) return errorResult("output_budget_too_small", "skill body exceeds output budget");
  return { isError: false, content: [{ type: "text", text: skill.markdown }] };
}
