import type { RuntimeConfig } from "../config.js";
import { ruleMatches } from "../tools/registry.js";
import { BACKEND_LABELS, type BackendKind } from "./config.js";

/** Built-ins whose job every supported CLI already does with its own tools; Raw skips them for a backend. */
export const NATIVE_DUPLICATES: Readonly<Record<string, string>> = Object.freeze({
  "builtin/read_file": "file reading tool",
  "builtin/write_file": "file editing tools",
  "builtin/edit_file": "file editing tools",
  "builtin/apply_patch": "file editing tools",
  "builtin/bash": "shell tool",
  "builtin/powershell": "shell tool",
  "builtin/view_image": "image reading",
});

/** Built-ins the CLIs have no equivalent for; Raw offers them through its bridge MCP server. */
export const BRIDGED_BUILTINS: readonly string[] = Object.freeze(["builtin/todo", "builtin/ask_user", "builtin/list_vars",
  "builtin/read_var", "builtin/list_skills", "builtin/load_skill", "builtin/process"]);

/** What a backend agent does with each agent key: `used`, or `skipped` because it configures Raw's own loop. */
export const AGENT_KEY_USE: Readonly<Record<string, "used" | "skipped">> = Object.freeze({
  model: "used", backend: "used", tools: "used", skills: "used", vars: "used", system_prompt: "used", system_prompt_file: "used",
  max_output_bytes: "used", request_timeout_ms: "used",
  request: "skipped", cache: "skipped", compact: "skipped", max_steps: "skipped", hooks: "skipped",
});

export interface BackendCompatibility {
  /** Tool ids offered to the CLI through the Raw bridge. */
  readonly bridged: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** One plain sentence per skipped item, naming the item and the backend. */
  readonly warnings: readonly string[];
}

const bridgedId = (id: string): boolean => BRIDGED_BUILTINS.includes(id) || /^(?:local|agent|pkg|pkgdep|mcp)\//.test(id);

export function classifyForBackend(runtime: Pick<RuntimeConfig, "agentName" | "backend" | "toolIds" | "hookIds" | "toolRules"
  | "backendIgnoredSettings">): BackendCompatibility {
  const backend = runtime.backend;
  if (!backend) return { bridged: [...runtime.toolIds], skipped: [], warnings: [] };
  const kind: BackendKind = backend.kind;
  const label = BACKEND_LABELS[kind];
  const who = `${kind} agent "${runtime.agentName ?? ""}"`;
  const bridged: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const skip = (id: string, reason: string) => skipped.push({ id, reason });
  for (const id of runtime.toolIds) {
    const native = NATIVE_DUPLICATES[id];
    if (native !== undefined) skip(id, `${label} uses its own ${native}`);
    else if (bridgedId(id)) bridged.push(id);
    else skip(id, `${label} cannot run it`);
  }
  if (runtime.hookIds.length) skip("hooks", "Raw hooks do not run for an external backend");
  for (const key of runtime.backendIgnoredSettings ?? []) skip(key, "it configures Raw's own agent loop");
  if (backend.tools !== undefined && kind !== "agy") skip("backend.tools", "it applies to agy only");
  const warnings = skipped.map((item) => `${who} skips ${item.id}: ${item.reason}`);
  const skippedTools = runtime.toolIds.filter((id) => !bridged.includes(id));
  for (const rule of runtime.toolRules) {
    if (skippedTools.some((id) => ruleMatches(rule.match, id)) && !bridged.some((id) => ruleMatches(rule.match, id))) {
      warnings.push(`rule "${rule.match}" cannot be enforced on ${label}'s own tools`);
    }
  }
  return { bridged, skipped, warnings };
}
