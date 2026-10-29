/** The `backend` block of an agent: an external coding CLI that runs the agent instead of Raw's own loop. */
export type BackendKind = "claude" | "codex" | "agy";

export const BACKEND_KINDS: readonly BackendKind[] = ["claude", "codex", "agy"];

export const BACKEND_LABELS: Readonly<Record<BackendKind, string>> = { claude: "Claude Code", codex: "Codex", agy: "agy" };

export interface BackendSpec {
  readonly kind: BackendKind;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  /** `replace` (default) swaps the CLI's system prompt for the agent's; `append` keeps the CLI's prompt and adds the agent's. */
  readonly systemPromptMode: "replace" | "append";
  readonly executable?: string;
  /** agy only: the tool names listed in the generated agent file's `tools:` front matter. */
  readonly tools?: readonly string[];
}

const FIELDS = ["kind", "model", "effort", "mode", "system_prompt_mode", "executable", "tools"];

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a nonempty string`);
  return value;
}

export function parseBackendSpec(raw: unknown, where: string): BackendSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!FIELDS.includes(key)) throw new Error(`unknown ${where} field: ${key}`);
  if (!BACKEND_KINDS.includes(value.kind as BackendKind)) throw new Error(`${where}.kind must be claude, codex or agy`);
  const mode = value.system_prompt_mode === undefined ? "replace" : value.system_prompt_mode;
  if (mode !== "replace" && mode !== "append") throw new Error(`${where}.system_prompt_mode must be "replace" or "append"`);
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error(`${where}.tools must be an array of nonempty strings`);
  }
  return Object.freeze({
    kind: value.kind as BackendKind,
    ...(value.model === undefined ? {} : { model: text(value.model, `${where}.model`) }),
    ...(value.effort === undefined ? {} : { effort: text(value.effort, `${where}.effort`) }),
    ...(value.mode === undefined ? {} : { mode: text(value.mode, `${where}.mode`) }),
    systemPromptMode: mode,
    ...(value.executable === undefined ? {} : { executable: text(value.executable, `${where}.executable`) }),
    ...(value.tools === undefined ? {} : { tools: Object.freeze([...value.tools as string[]]) }),
  });
}
