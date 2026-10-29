import type { AgentState, RunEvent, RunResult } from "../agent.js";
import type { CompactOptions, CompactResult } from "../compact.js";
import type { UsageSummary } from "../llm/cache.js";
import type { ModelMessage, UserInput } from "../llm/types.js";
import type { ToolDisplay } from "../tools/display.js";

export interface PanelActionRequest { panel: string; action: string; block?: string; item?: string; viewInstanceId?: string }

/**
 * What the host (dashboard operations, CLI, REPL) needs from the thing that runs a session's turns: Raw's own loop
 * (`AgentSession`) or an external CLI backend. The host depends on nothing else.
 */
export interface SessionAgent {
  readonly state: AgentState;
  readonly transcript: readonly ModelMessage[];
  start(source: "create" | "resume", onEvent?: (event: RunEvent) => void, signal?: AbortSignal): Promise<void>;
  run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult>;
  runPanelAction(request: PanelActionRequest, onEvent?: (event: RunEvent) => void): Promise<RunResult>;
  compact(options?: CompactOptions, onEvent?: (event: RunEvent) => void): Promise<CompactResult>;
  /** Stops the turn in progress; false when nothing was running. */
  abort(): boolean;
  close(onEvent?: (event: RunEvent) => void): Promise<void>;
  stats(fromRequest?: number): UsageSummary;
  /** The conversation size now; `window` is the context size when the agent knows it without a Raw model config. */
  contextUsage(): { tokens: number; source: "provider" | "estimate"; window?: number };
  toolIdentity(name: string): string | undefined;
  toolDisplay(name: string): ToolDisplay | undefined;
}
