import type { CompactionDetails, RunResult } from "../agent.js";
import { base64ByteLength, type UserBlock } from "../llm/types.js";
import type { ToolResult } from "../tools/types.js";
import type { HistoryItem } from "./store.js";
import type { HookReceipt } from "../hooks/dispatcher.js";
import { projectToolResult, type VisibleToolCall, type VisibleToolResult } from "./visible.js";

/** Metadata of one non-text block of a user message; bytes are served separately, never embedded in a view. */
import type { PanelReceipt } from "../panels/contract.js";
export interface HistoryAttachment { index: number; kind: string; name: string; mimeType: string | null; byteSize: number | null }
/** The non-text blocks of a stored user input, in order. `HistoryAttachment.index` addresses this list. */
export function userAttachmentBlocks(input: unknown): UserBlock[] {
  return Array.isArray(input) ? (input as UserBlock[]).filter((block) => block.type !== "text") : [];
}
function attachmentView(block: UserBlock, index: number): HistoryAttachment {
  if (block.type === "image") return { index, kind: "image", name: block.name ?? `image.${block.mimeType === "image/png" ? "png" : "jpg"}`,
    mimeType: block.mimeType, byteSize: base64ByteLength(block.data) };
  if (block.type === "resource_link") return { index, kind: "file", name: block.name, mimeType: block.mimeType ?? null, byteSize: block.size ?? null };
  return { index, kind: "unknown", name: "attachment", mimeType: null, byteSize: null };
}
export interface HistoryView {
  id: string;
  sequence: number;
  createdAt: number;
  kind: string;
  status: string;
  text?: string;
  attachments?: HistoryAttachment[];
  turnId?: string;
  operationId?: string;
  callId?: string;
  toolState?: "requested" | "running" | "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";
  toolCall?: VisibleToolCall;
  toolResult?: VisibleToolResult;
  previewOnly?: boolean;
  previewAbbreviated?: boolean;
  compaction?: CompactionDetails;
  runResult?: RunResult;
  hook?: HookReceipt;
  panelReceipt?: PanelReceipt;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function projectHistoryItem(item: HistoryItem): HistoryView {
  const payload = item.payload;
  const update = object(payload.update);
  const view: HistoryView = { id: typeof payload.segmentId === "string" ? payload.segmentId : `history:${item.sequence}`,
    sequence: item.sequence, createdAt: item.createdAt, kind: item.kind, status: item.status,
    ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
    ...(typeof payload.operationId === "string" ? { operationId: payload.operationId } : {}) };
  if (item.kind === "user") {
    if (Array.isArray(payload.input)) {
      view.text = (payload.input as UserBlock[]).flatMap((block) => block.type === "text" ? [block.text] : []).join("");
      const attachments = userAttachmentBlocks(payload.input).map(attachmentView);
      if (attachments.length) view.attachments = attachments;
    } else view.text = typeof payload.input === "string" ? payload.input : String(payload.text ?? "");
  }
  else if (["assistant", "reasoning", "status", "runtime_transition", "skill_notice"].includes(item.kind)) {
    view.text = String(object(update.content).text ?? payload.text ?? "");
  } else if (item.kind === "compaction") view.compaction = structuredClone(payload) as unknown as CompactionDetails;
  else if (item.kind === "run_end") view.runResult = structuredClone(payload.result) as RunResult;
  else if (item.kind === "panel_receipt") {
    const { turnId: _turn, operationId: _operation, ...receipt } = payload;
    view.panelReceipt = receipt as unknown as PanelReceipt;
  } else if (item.kind === "hook_event") view.hook = {
    id: String(payload.id), event: payload.event as HookReceipt["event"], outcome: payload.outcome as HookReceipt["outcome"],
    durationMs: Number(payload.durationMs),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(typeof payload.code === "string" ? { code: payload.code } : {}),
  };
  else if (item.kind === "tool_call") {
    const display = payload.display as VisibleToolCall | undefined;
    view.toolCall = display ? structuredClone(display) : {
      id: String(update.toolCallId ?? ""), name: String(update.name ?? update.title ?? "tool"),
      arguments: structuredClone(object(update.rawInput)), started: update.status === "in_progress",
    };
    view.callId = view.toolCall.id ?? `unknown:${item.sequence}`;
    view.toolState = view.toolCall.started ? "running" : "requested";
  } else if (item.kind === "tool_result") {
    const display = payload.display as VisibleToolResult | undefined;
    const raw = object(update.rawOutput);
    view.toolResult = display ? structuredClone(display) : projectToolResult("tool", undefined,
      Array.isArray(raw.content) ? raw as unknown as ToolResult : { isError: update.status === "failed",
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        content: [{ type: "text", text: String(raw.preview ?? JSON.stringify(raw)) }] });
    view.callId = display?.id ?? (typeof update.toolCallId === "string" ? update.toolCallId : `unknown:${item.sequence}`);
    const code = view.toolResult.code;
    view.toolState = code === "outcome_unknown" ? "outcome_unknown" : code === "cancelled" || code === "aborted" ? "cancelled"
      : code === "denied" || code === "approval_denied" || code === "tool_denied" ? "denied"
      : view.toolResult.failed ? "failed" : "succeeded";
    view.previewOnly = true;
    view.previewAbbreviated = view.toolResult.segments.some((segment) => /\[middle (?:lines|characters) hidden\]/.test(segment.text));
  } else if (item.kind === "acp_update") {
    if (update.sessionUpdate === "tool_call_update") {
      view.kind = "tool_state"; view.callId = String(update.toolCallId ?? "");
      view.toolState = update.status === "in_progress" ? "running" : "requested";
    } else view.text = String(object(update.content).text ?? "");
  }
  return view;
}
