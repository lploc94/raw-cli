import type { RunEvent } from "../agent.js";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { renderUserInput } from "../llm/types.js";
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
  return undefined;
}

export function renderStoredHistory(item: HistoryItem): string {
  const payload = item.payload;
  if (item.kind === "user") return `user: ${renderUserInput(payload.input as Parameters<typeof renderUserInput>[0])}`;
  if (item.kind === "assistant") {
    const update = payload.update as { content?: { text?: string } } | undefined;
    return String(update?.content?.text ?? payload.text ?? "");
  }
  if (item.kind === "reasoning") return `raw: thinking\n${String(payload.text ?? "")}`;
  if (item.kind === "status") return String(payload.text ?? "");
  if (item.kind === "tool_call" && !payload.update) {
    const display = payload.display as VisibleToolCall;
    return `raw: ${display.started ? "" : "⚠ "}${display.name} ${JSON.stringify(display.arguments)}`;
  }
  if (item.kind === "tool_result" && !payload.update) {
    const display = payload.display as VisibleToolResult;
    const meta = [
      ...(typeof display.exitCode === "number" ? [`exit ${display.exitCode}`] : []),
      ...(display.code ? [display.code] : []),
      ...(display.truncated ? ["model output capped"] : []),
    ];
    const preview = renderPlainToolResult(display);
    return `raw: ${display.failed ? "✗" : "↳"} ${display.name} result${meta.length ? ` (${meta.join(", ")})` : ""}${preview ? `\n${preview}` : " (empty)"}`;
  }
  const update = payload.update as Record<string, unknown> | undefined;
  if (update?.sessionUpdate === "tool_call") return `raw: ${String(update.name ?? update.title)} ${JSON.stringify(update.rawInput)}`;
  if (update?.sessionUpdate === "tool_call_update") {
    return `raw: ${String(update.toolCallId)} ${String(update.status)}${update.rawOutput === undefined ? "" : `\n${JSON.stringify(update.rawOutput)}`}`;
  }
  if (update?.sessionUpdate === "agent_thought_chunk") {
    return `raw: ${String((update.content as { text?: string } | undefined)?.text ?? "")}`;
  }
  return JSON.stringify(payload);
}

export function storedAcpUpdates(item: HistoryItem): SessionUpdate[] {
  const payload = item.payload;
  if (payload.update && typeof payload.update === "object") return [payload.update as SessionUpdate];
  if (item.kind === "user") {
    const input = payload.input as UserInput;
    const blocks = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
    return blocks.map((block) => ({ sessionUpdate: "user_message_chunk", content: block as ContentBlock }));
  }
  if (item.kind === "assistant") return [{ sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: String(payload.text ?? "") } }];
  if (item.kind === "reasoning" || item.kind === "status") return [{ sessionUpdate: "agent_thought_chunk",
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
