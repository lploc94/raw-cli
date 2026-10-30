/** An external coding CLI that runs an agent instead of Raw's own loop, declared as a model with a CLI `method`. */
export type BackendKind = "claude" | "codex" | "agy";

export const BACKEND_KINDS: readonly BackendKind[] = ["claude", "codex", "agy"];

export const BACKEND_LABELS: Readonly<Record<BackendKind, string>> = { claude: "Claude Code", codex: "Codex", agy: "agy" };

/** The model `method` that names each CLI. */
export const CLI_METHODS: Readonly<Record<string, BackendKind>> = Object.freeze({
  "claude-code-cli": "claude", "codex-cli": "codex", "antigravity-cli": "agy",
});

export const isCliMethod = (method: unknown): method is string => typeof method === "string" && Object.hasOwn(CLI_METHODS, method);

/** What the runtime needs to run an agent on a CLI; derived from the CLI model entry and the agent. */
export interface BackendSpec {
  readonly kind: BackendKind;
  /** The model's `model_id`; unset runs the CLI's default model. */
  readonly model?: string;
  /** The agent's `request.reasoning_effort`. */
  readonly effort?: string;
  /** The agent's `request.mode`: the CLI's permission mode. */
  readonly mode?: string;
  /** The agent's `system_prompt_mode`: `replace` (default) swaps the CLI's system prompt for the agent's; `append` keeps the CLI's prompt and adds the agent's. */
  readonly systemPromptMode: "replace" | "append";
  /** The model's `executable`. */
  readonly executable?: string;
}
