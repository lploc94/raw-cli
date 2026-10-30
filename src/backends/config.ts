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
  /** The model's `context_window_tokens`: the window the CLI compacts against (Claude Code, Codex). */
  readonly contextWindow?: number;
  /** The agent's `compact.trigger_tokens`: where the CLI compacts (Codex only; Claude Code keeps its own buffer). */
  readonly compactTrigger?: number;
}

/** Claude Code compacts at its window minus this buffer, whatever the window (measured on Claude Code 2.1.312, 2026-10-30). */
export const CLAUDE_COMPACT_BUFFER = 33_000;

/** The window a CLI takes from the model and compacts against; agy takes none, so its configured value is not one. */
export function backendContextWindow(spec: BackendSpec): number | undefined {
  return spec.kind === "agy" ? undefined : spec.contextWindow;
}

/** Codex compacts at 90% of its window at most, whatever limit it is given (`auto_compact_token_limit`, Codex 0.165.0). */
export function codexCompactCap(window: number): number {
  return Math.floor(window * 9 / 10);
}

/**
 * Where the CLI compacts, when Raw sets what decides it. Codex: with the agent's trigger and the model's window, Codex's own
 * value (the trigger capped at 90% of the window); with the trigger alone an estimate, since Codex caps it by a window Raw
 * does not know; with the window alone nothing, since a trigger the user's CODEX_CONFIG sets may still apply. Claude Code:
 * an estimate from the window Raw gives it.
 */
export function backendCompactTrigger(spec: BackendSpec): { tokens: number; estimated: boolean } | undefined {
  if (spec.kind === "codex") {
    if (spec.compactTrigger === undefined) return undefined;
    if (spec.contextWindow === undefined) return { tokens: spec.compactTrigger, estimated: true };
    return { tokens: Math.min(spec.compactTrigger, codexCompactCap(spec.contextWindow)), estimated: false };
  }
  if (spec.kind === "claude" && spec.contextWindow !== undefined && spec.contextWindow > CLAUDE_COMPACT_BUFFER) {
    return { tokens: spec.contextWindow - CLAUDE_COMPACT_BUFFER, estimated: true };
  }
  return undefined;
}
