import type { ModelMessage } from "../llm/types.js";
import type { StoredAgentState } from "./store.js";

export function isEphemeralPeerAlias(name: string): boolean { return /^raw_[A-Za-z0-9_-]+_[a-f0-9]{12}$/.test(name); }

export function validateStoredAgentState(state: StoredAgentState): void {
  if (!state.cacheKey || !Number.isSafeInteger(state.schemaRevision) || state.schemaRevision < 1
    || !Number.isFinite(state.tokenCalibration) || state.tokenCalibration < 1
    || !Array.isArray(state.messages) || !Array.isArray(state.rawUsage) || !Array.isArray(state.usageEntries)) {
    throw new Error("invalid saved agent state");
  }
  if (state.selectedTools !== null && (!Array.isArray(state.selectedTools)
    || state.selectedTools.some((name) => typeof name !== "string" || !name))) throw new Error("invalid saved tool selection");
  let pending = new Map<string, string>();
  for (const message of state.messages) {
    if (!message || typeof message !== "object") throw new Error("invalid saved model message");
    if (message.role === "user") {
      if (pending.size) throw new Error("saved tool call has no result");
      if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new Error("invalid saved user input");
    } else if (message.role === "assistant") {
      if (pending.size || typeof message.text !== "string" || !Array.isArray(message.toolCalls)) throw new Error("invalid saved assistant message");
      pending = new Map(message.toolCalls.map((call) => [call.id, call.name]));
      if (pending.size !== message.toolCalls.length) throw new Error("duplicate saved tool call ID");
    } else if (message.role === "tool") {
      if (pending.get(message.callId) !== message.name || !message.result || !Array.isArray(message.result.content)) {
        throw new Error("invalid saved tool result linkage");
      }
      pending.delete(message.callId);
    } else throw new Error("invalid saved model role");
  }
  if (pending.size) throw new Error("saved tool call has no result");
  if (state.messages.length && state.messages[0]?.role !== "user") throw new Error("saved context must begin with user input");
}

export function cloneModelMessage(message: ModelMessage): ModelMessage { return structuredClone(message); }
