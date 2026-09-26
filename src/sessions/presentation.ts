import type { RunEvent } from "../agent.js";
import { acpUpdate } from "./display.js";
import type { VisibleRecord } from "./store.js";
import { projectToolCall, type VisibleToolResult } from "./visible.js";

export type HistorySurface = "cli" | "acp" | "web";

/** Transport presentation is host state; it never changes a model message. */
export function historyPresentation(surface: HistorySurface | undefined) {
  const canonical = surface !== "acp";
  return {
    messages(segments: readonly { kind: "assistant" | "reasoning"; text: string; segmentId: string }[], status: string): VisibleRecord[] {
      if (canonical) return segments.map(({ kind, text, segmentId }) => ({ kind, payload: { text, segmentId }, status }));
      return segments.filter((item) => item.kind === "assistant").map(({ text, segmentId }) => ({
        kind: "assistant", payload: { update: acpUpdate({ type: "text_delta", text }), segmentId }, status,
      }));
    },
    declaration(id: string, name: string, args: Record<string, unknown>): VisibleRecord[] {
      return canonical ? [] : [{ kind: "tool_call", payload: { update: acpUpdate({ type: "tool_call", id, name, arguments: args }) } }];
    },
    start(id: string, name: string, identity: string | undefined, args: Record<string, unknown>): VisibleRecord[] {
      return canonical ? [{ kind: "tool_call", payload: { display: { ...projectToolCall(name, identity, args, true), id } } }]
        : [{ kind: "acp_update", payload: { update: acpUpdate({ type: "tool_start", id, name, arguments: args }) } }];
    },
    result(event: Extract<RunEvent, { type: "tool_result" }>, identity: string | undefined,
      args: Record<string, unknown>, started: boolean, display: VisibleToolResult): VisibleRecord[] {
      if (!canonical) return [{ kind: "tool_result", payload: { update: acpUpdate(event) } }];
      return [...(started ? [] : [{ kind: "tool_call", payload: {
        display: { ...projectToolCall(event.name, identity, args, false), id: event.id },
      } }]), { kind: "tool_result", payload: { display } }];
    },
  };
}
