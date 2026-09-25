import { viewImageTool } from "../../image.js";
import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return viewImageTool(args as { path: string }, context);
}
