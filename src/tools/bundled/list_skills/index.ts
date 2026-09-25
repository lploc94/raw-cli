import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export async function handler(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return { isError: false, content: [{ type: "json", value: {
    skills: (context.skills ?? []).map(({ name, description }) => ({ name, description })),
  } }] };
}
