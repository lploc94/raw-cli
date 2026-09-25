import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const skill = context.skills?.find((item) => item.name === args.name);
  if (!skill) return { isError: true, code: "unknown_skill", content: [{ type: "text", text: "skill is not selected" }] };
  return { isError: false, content: [{ type: "text", text: skill.markdown }] };
}
