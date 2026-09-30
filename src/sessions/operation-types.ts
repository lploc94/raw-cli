import type { RunResult } from "../agent.js";
import type { CompactResult } from "../compact.js";
import type { SessionMetrics } from "./metrics.js";

export type OperationState = "accepted" | "starting" | "running" | "compacting" | "completed" | "max_steps" | "cancelled" | "error" | "interrupted";
export interface OperationIntent {
  sessionId: string;
  clientRequestId: string;
  kind: "turn" | "compact" | "panel_action";
  agentName: string;
  configPath: string;
  input?: string;
  /** For `panel_action`: the full panel id and what the user picked (docs/panels-design.md §11). */
  action?: { panel: string; action: string; block?: string; item?: string; viewInstanceId?: string };
}
export interface SessionOperation extends OperationIntent {
  id: string;
  state: OperationState;
  ownerGeneration: number;
  acceptedAt: number;
  updatedAt: number;
  committedUserPosition?: number;
  result?: RunResult | CompactResult;
  error?: { code: string; message: string };
  metrics?: SessionMetrics;
}
export const terminalOperationStates: ReadonlySet<OperationState> = new Set(["completed", "max_steps", "cancelled", "error", "interrupted"]);
export class SessionOperationError extends Error {
  constructor(readonly code: "conflict" | "busy" | "not_found" | "invalid_input" | "closed" | "agent_mismatch", message: string) {
    super(message); this.name = "SessionOperationError";
  }
}
