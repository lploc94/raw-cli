import { getEncoding } from "js-tiktoken";
import { DEFAULT_SYSTEM_PROMPT } from "../src/llm/prompt.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function countOverhead() {
  const encoder = getEncoding("o200k_base");
  const definitions = BUILTIN_TOOL_DEFINITIONS;
  const canonical = JSON.stringify(canonicalize({ system: DEFAULT_SYSTEM_PROMPT, tools: definitions }));
  return {
    promptTokens: encoder.encode(DEFAULT_SYSTEM_PROMPT).length,
    combinedTokens: encoder.encode(canonical).length,
    definitions,
    canonical,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = countOverhead();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.promptTokens > 50 || report.definitions.length !== 3) process.exitCode = 1;
}
