import type { ToolPolicyWhen } from "../tools/policy.js";

export const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export type HookEventName = typeof hookEvents[number];
export const toolHookEvents = new Set<HookEventName>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

export interface HookSubscription { name: HookEventName; match?: string; when?: ToolPolicyWhen }
export interface HookManifest {
  name: string;
  events: readonly HookSubscription[];
  command: string;
  args: readonly string[];
  timeoutMs: number;
}
export interface SelectedHook extends HookManifest { id: string; folder: string }

export interface HookRequest {
  protocol_version: 1;
  event: HookEventName;
  cwd: string;
  agent_id?: string;
  session_id?: string;
  turn_id?: string;
  source?: "create" | "resume";
  input?: unknown;
  tool?: { identity: string; name: string; arguments: Record<string, unknown>; result?: unknown };
  run?: unknown;
}
export interface HookExecution { decision: "continue" | "deny"; reason?: string; message?: string; durationMs: number }

export class HookError extends Error {
  constructor(readonly code: string, readonly hookId: string) { super(`hook ${hookId} failed: ${code}`); }
}
