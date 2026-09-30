export type ProcessState = "starting" | "running" | "stopping" | "exited" | "failed" | "stopped" | "timed_out" | "lost";
export interface ProcessRecord {
  id: string; sessionId: string; hostToken: string; hostGeneration: number; revision: number;
  command: string; cwd: string; label?: string; state: ProcessState; createdAt: number; updatedAt: number;
  endedAt?: number; exitCode?: number | null; signal?: string | null; error?: string;
  earliestCursor: number; cursor: number; droppedBytes: number;
}
export interface ProcessChunk { channel: "stdout" | "stderr"; start: number; end: number; text: string }
export interface ProcessOutput { id: string; chunks: ProcessChunk[]; earliestCursor: number; nextCursor: number; cursor: number; droppedBytes: number; truncated: boolean }
export interface ProcessStart { command: string; cwd: string; label?: string; timeout_ms?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; bashPath?: string }
export interface ProcessContext {
  start(input: ProcessStart): Promise<ProcessRecord>;
  list(): ProcessRecord[];
  status(id: string): ProcessRecord;
  output(id: string, cursor?: number, maxBytes?: number): ProcessOutput;
  stop(id: string): Promise<ProcessRecord>;
}
export const LIVE_PROCESS_STATES: readonly ProcessState[] = ["starting", "running", "stopping"];
export class ProcessError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ProcessError"; }
}
