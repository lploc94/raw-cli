import type { ToolDefinition } from "../src/tools/registry.js";

export interface OverheadReport {
  promptTokens: number;
  combinedTokens: number;
  definitions: readonly ToolDefinition[];
  canonical: string;
}

export function countOverhead(): OverheadReport;
