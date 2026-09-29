import type { RunEvent } from "../agent.js";
import { receiptLine } from "../panels/render.js";
import type { PanelReceipt } from "../panels/contract.js";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import type { UserInput } from "../llm/types.js";
import type { HistoryItem } from "./store.js";
import { projectToolCall, renderPlainToolResult, type VisibleToolCall, type VisibleToolResult } from "./visible.js";

export function toolArguments(name: string, args: Record<string, unknown>, full = false, identity?: string): string {
  const json = JSON.stringify(projectToolCall(name, identity, args, true).arguments);
  return full || identity === "builtin/bash" || json.length <= 240 ? json : `${json.slice(0, 239)}…`;
}


export function acpUpdate(event: RunEvent): SessionUpdate | undefined {
  if (event.type === "text_delta") return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
  if (event.type === "tool_call") return { sessionUpdate: "tool_call", toolCallId: event.id, title: event.name,
    name: event.name, kind: event.name === "read_file" ? "read" : event.name === "write_file" ? "edit" : "execute",
    status: "pending", rawInput: event.arguments };
  if (event.type === "tool_start") return { sessionUpdate: "tool_call_update", toolCallId: event.id, status: "in_progress" };
  if (event.type === "tool_result") return { sessionUpdate: "tool_call_update", toolCallId: event.id,
    status: event.result.isError ? "failed" : "completed", rawOutput: event.result };
  if (event.type === "compact_start") return { sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `Compacting context (${event.estimatedTokens} estimated input tokens).` } };
  if (event.type === "compact_end") return { sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `Context compact ${event.result.status}.` } };
  if (event.type === "hook_event") return { sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `Hook ${event.id} ${event.event}: ${event.outcome}${event.message ? ` · ${event.message}` : event.code ? ` · ${event.code}` : ""}` } };
  return undefined;
}

export function storedAcpUpdates(item: HistoryItem): SessionUpdate[] {
  const payload = item.payload;
  if (item.kind === "compaction") return [{ sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `Context compaction: ${String(payload.status)}.` } }];
  if (item.kind === "run_end") return [];
  if (item.kind === "panel_receipt") return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: receiptLine(payload as unknown as PanelReceipt).trim() } }];
  if (item.kind === "hook_event") return [acpUpdate({ type: "hook_event", id: String(payload.id),
    event: payload.event as Extract<RunEvent, { type: "hook_event" }>["event"],
    outcome: payload.outcome as Extract<RunEvent, { type: "hook_event" }>["outcome"],
    durationMs: Number(payload.durationMs),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(typeof payload.code === "string" ? { code: payload.code } : {}) })!];
  if (payload.update && typeof payload.update === "object") return [payload.update as SessionUpdate];
  if (item.kind === "user") {
    const input = payload.input as UserInput;
    const blocks = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
    return blocks.map((block) => ({ sessionUpdate: "user_message_chunk", content: block as ContentBlock }));
  }
  if (item.kind === "assistant") return [{ sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: String(payload.text ?? "") } }];
  if (item.kind === "reasoning" || item.kind === "status" || item.kind === "runtime_transition") return [{ sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: String(payload.text ?? "") } }];
  if (item.kind === "tool_call") {
    const display = payload.display as VisibleToolCall;
    return [{ sessionUpdate: "tool_call", toolCallId: String(display.id), title: display.name,
      name: display.name, kind: "execute", status: display.started ? "pending" : "failed", rawInput: display.arguments }];
  }
  if (item.kind === "tool_result") {
    const display = payload.display as VisibleToolResult;
    return [{ sessionUpdate: "tool_call_update", toolCallId: String(display.id), status: display.failed ? "failed" : "completed",
      rawOutput: { isError: display.failed, code: display.code, exitCode: display.exitCode,
        truncated: display.truncated, preview: renderPlainToolResult(display) } }];
  }
  return [];
}
