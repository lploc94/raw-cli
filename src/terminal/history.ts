import type { HistoryItem } from "../sessions/store.js";
import type { VisibleToolCall, VisibleToolResult } from "../sessions/visible.js";
import { projectToolResult } from "../sessions/visible.js";
import { renderUserInput } from "../llm/types.js";
import { renderMarkdown } from "./markdown.js";
import { resolveUiOptions, terminalCapabilities, type TerminalCapabilities, type UiOptions } from "./options.js";
import { safeTerminalText } from "./safe.js";
import { icon, paint } from "./theme.js";
import { formatToolResult, formatToolStart } from "./tools.js";

export function renderTerminalHistory(item: HistoryItem, ui: UiOptions = resolveUiOptions(),
  caps: TerminalCapabilities = terminalCapabilities(false, process.env, ui), width = 80): string {
  const payload = item.payload;
  if (item.kind === "user") return `${paint("accent", icon("user", ui, caps), ui, caps)} ${safeTerminalText(renderUserInput(payload.input as Parameters<typeof renderUserInput>[0]))}\n`;
  if (item.kind === "assistant") {
    const update = payload.update as { content?: { text?: string } } | undefined;
    const source = String(update?.content?.text ?? payload.text ?? "");
    return `${paint("accent", icon("assistant", ui, caps), ui, caps)} ${renderMarkdown(source, ui, caps, Math.max(8, width - 2))}`;
  }
  if (item.kind === "reasoning") {
    if (ui.reasoning === "hidden") return "";
    const label = `${icon("thinking", ui, caps)} Thinking…`;
    return `${paint("thinking", label, ui, caps)}\n${ui.reasoning === "full" ? paint("thinking", safeTerminalText(String(payload.text ?? "")), ui, caps) + "\n" : ""}`;
  }
  if (item.kind === "status") return `${safeTerminalText(String(payload.text ?? ""))}\n`;
  if (item.kind === "runtime_transition") return `${paint("thinking", icon("attention", ui, caps), ui, caps)} ${safeTerminalText(String(payload.text ?? ""))}\n`;
  if (item.kind === "tool_call") {
    const display = payload.display as VisibleToolCall | undefined;
    if (display) return formatToolStart(display, ui, caps, width);
    const update = payload.update as { name?: string; title?: string; rawInput?: unknown; status?: string } | undefined;
    return update ? `${icon(update.status === "failed" ? "failure" : "generic", ui, caps)} ${safeTerminalText(update.name ?? update.title ?? "tool")}`
      + `${update.rawInput === undefined ? "" : `  ${safeTerminalText(JSON.stringify(update.rawInput))}`}\n` : "";
  }
  if (item.kind === "tool_result") {
    const display = payload.display as VisibleToolResult | undefined;
    if (display) return formatToolResult(display, ui, caps, width);
    const update = payload.update as { toolCallId?: string; rawOutput?: unknown; status?: string } | undefined;
    const raw = update?.rawOutput as { isError?: boolean; content?: Array<{ type: "text"; text: string }> } | undefined;
    const projected = raw && Array.isArray(raw.content)
      ? projectToolResult(update?.toolCallId ?? "tool", undefined, { isError: raw.isError === true || update?.status === "failed", content: raw.content })
      : projectToolResult(update?.toolCallId ?? "tool", undefined, { isError: update?.status === "failed",
        content: [{ type: "text", text: safeTerminalText(JSON.stringify(raw ?? update?.rawOutput ?? "")) }] });
    return formatToolResult(projected, ui, caps, width);
  }
  if (item.kind === "acp_update") {
    const update = payload.update as { content?: { text?: string } } | undefined;
    return update?.content?.text ? `${safeTerminalText(update.content.text)}\n` : "";
  }
  return `${safeTerminalText(JSON.stringify(payload))}\n`;
}
