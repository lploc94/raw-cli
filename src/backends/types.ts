import type { AgentState, RunEvent, RunResult } from "../agent.js";
import type { CompactOptions, CompactResult } from "../compact.js";
import type { UsageSummary } from "../llm/cache.js";
import type { ModelMessage, UserInput } from "../llm/types.js";
import type { ToolDisplay } from "../tools/display.js";

/** A background task's state: the AIR states of the installed adapters (`async-tasks.js` `taskState`), and Raw's `lost`. */
export type CliTaskState = "running" | "paused" | "completed" | "failed" | "stopped" | "lost";

/** One background task of the CLI conversation, as the adapter reported it (AIR `async_task_*`). */
export interface CliTask {
  id: string;
  name: string;
  /** `shell`, `turn`, `monitor`, … as the adapter names it. */
  type: string;
  description?: string;
  state: CliTaskState;
  canStop: boolean;
  toolCallId?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  outputFilePath?: string;
}

/**
 * What a backend reports about work outside Raw's turns: its task list changed, a CLI turn waits to be run
 * (`BackgroundWork.runCliTurn`), the CLI said something outside any turn, or its adapter exited.
 */
export type BackgroundEvent =
  | { type: "tasks"; tasks: CliTask[] }
  | { type: "cli_turn" }
  | { type: "notice"; text: string }
  | { type: "exited"; message: string };

/** A backend CLI's background work (Claude Code, Codex): its tasks, and the turns it takes after them (CLI turns). */
export interface BackgroundWork {
  tasks(): CliTask[];
  /** Reports work outside Raw's turns; returns the unsubscribe. */
  onEvent(listener: (event: BackgroundEvent) => void): () => void;
  stop(id: string): Promise<boolean>;
  stopAll(): Promise<void>;
  /** A live task, a CLI turn not yet recorded, or a finished task the CLI has not been told about. */
  hasWork(): boolean;
  /** `hasWork()`, or a turn Claude Code may still start after Raw delivered a completion itself. */
  keepsAdapter(): boolean;
  /** The note of the CLI turn waiting to run, if any. */
  cliTurnNote(): string | undefined;
  /** Runs the waiting CLI turn as a Raw turn; with none waiting it records nothing. */
  runCliTurn(onEvent?: (event: RunEvent) => void): Promise<RunResult>;
  /** The host could not run the waiting CLI turn: it is stopped and its text kept as a notice. */
  abandonCliTurn(): Promise<void>;
}

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
  /** A backend CLI's background work; absent for Raw's own loop and agy. */
  readonly background?: BackgroundWork | undefined;
}
