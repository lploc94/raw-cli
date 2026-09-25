import type { ToolResult } from "../tools/types.js";
import type { RunEvent } from "../agent.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const RESULT_PREVIEW_CHARS = 2000;
const RESULT_PREVIEW_LINES = 9; // The result header is the tenth displayed line.

export function resultPreview(name: string, result: ToolResult): string {
  const channels = new Set(result.content.flatMap((block) => block.type === "text" && block.channel ? [block.channel] : []));
  const labelChannels = channels.size > 1;
  const body = result.content.map((block) => {
    if (block.type === "text") return `${labelChannels && block.channel ? `[${block.channel}]\n` : ""}${block.text}`;
    if (block.type === "json") {
      const value = block.value as { results?: unknown } | null;
      if (["read_file", "write_file", "bash"].includes(name) && value && !Array.isArray(value) && Array.isArray(value.results)
        && value.results.every((row) => row && typeof row === "object" && !Array.isArray(row)
          && Number.isSafeInteger(row.index) && typeof row.status === "string")) {
        const rows = value.results as Array<Record<string, unknown>>;
        const statuses = rows.map((row) => `${row.index}:${row.status}${typeof row.exit_code === "number" ? `(exit${row.exit_code})` : ""}`).join(" ");
        return `statuses: ${statuses}\n${rows.map((row) => JSON.stringify(row)).join("\n")}`;
      }
      return JSON.stringify(block.value);
    }
    return `[${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes]`;
  }).join("\n").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!body) return "";
  const lines = body.split("\n");
  const lineLimited = lines.length > RESULT_PREVIEW_LINES
    ? [...lines.slice(0, 4), "… [middle lines hidden] …", ...lines.slice(-4)].join("\n") : body;
  const characters = Array.from(lineLimited);
  if (characters.length <= RESULT_PREVIEW_CHARS) return lineLimited;
  const marker = "… [middle characters hidden] …";
  const remaining = RESULT_PREVIEW_CHARS - Array.from(marker).length;
  return characters.slice(0, Math.ceil(remaining / 2)).join("") + marker
    + characters.slice(-Math.floor(remaining / 2)).join("");
}

export function toolArguments(name: string, args: Record<string, unknown>, full = false): string {
  const display = name === "write_file" && Array.isArray(args.operations)
    ? { operations: args.operations.map((value: unknown) => {
      const op = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { path: op.path, mode: op.mode,
        ...(typeof op.content === "string" ? { content_bytes: Buffer.byteLength(op.content, "utf8") } : {}),
        ...(typeof op.old_text === "string" ? { old_text_bytes: Buffer.byteLength(op.old_text, "utf8") } : {}),
        ...(typeof op.new_text === "string" ? { new_text_bytes: Buffer.byteLength(op.new_text, "utf8") } : {}),
        ...(op.start_line !== undefined ? { start_line: op.start_line } : {}),
        ...(op.end_line !== undefined ? { end_line: op.end_line } : {}),
      };
    }) } : args;
  const json = JSON.stringify(display);
  return full || name === "bash" || json.length <= 240 ? json : `${json.slice(0, 239)}…`;
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
