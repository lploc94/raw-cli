import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { projectToolCall, projectToolResult, type VisibleToolCall, type VisibleToolResult } from "../sessions/visible.js";
import type { ToolKind } from "../tools/display.js";
import type { ToolResult } from "../tools/types.js";

/** What one ACP `session/update` means to Raw: chat text, a CLI tool call, or session state that is not chat. */
export type AcpTurnEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown>; display: VisibleToolCall }
  | { type: "tool_result"; id: string; name: string; result: ToolResult; display: VisibleToolResult; call: VisibleToolCall; started: boolean }
  | { type: "context"; used: number; size: number }
  | { type: "config"; options: SessionConfigOption[] }
  | { type: "notice"; message: string }
  | { type: "unknown"; kind: string };

/**
 * The update kinds of `@agentclientprotocol/sdk` 1.5.0's `SessionUpdate`. The SDK rejects any other kind before a handler
 * sees it, so the runner reports and drops those itself (Invariant 8).
 */
export const KNOWN_UPDATE_KINDS: ReadonlySet<string> = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk",
  "tool_call", "tool_call_update", "plan", "plan_update", "plan_removed", "available_commands_update", "current_mode_update",
  "config_option_update", "session_info_update", "usage_update", "notice", "compaction_update", "compaction_summary_chunk"]);

interface OpenCall {
  name: string;
  title: string;
  kind: ToolKind;
  arguments: Record<string, unknown>;
  started: boolean;
  startedAt: number;
  /** Command output a CLI streams in `_meta` instead of content (codex-acp without a client terminal). */
  output: string;
  exitCode?: number | null;
  /** The latest `content` an update set; ACP replaces it with each update that carries it. */
  content: NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]>;
  rawOutput?: unknown;
}

const TITLE_CHARS = 120;
const KINDS: Record<string, ToolKind> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search",
  execute: "execute", think: "think", fetch: "fetch" };
/** Updates that change session state the runtime keeps, never the chat. */
const STATE_UPDATES = new Set(["available_commands_update", "session_info_update", "current_mode_update"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return [...line].length <= TITLE_CHARS ? line : `${[...line].slice(0, TITLE_CHARS - 1).join("")}…`;
};

/**
 * The Raw tool a CLI tool call runs through the Raw bridge's MCP server `raw`, from what each adapter itself writes for an
 * MCP call: claude-agent-acp names it `mcp__raw__<tool>`; codex-acp titles it `mcp.raw.<tool>` with `rawInput {server,
 * tool}` (`McpToolReporter`). Tool arguments alone never make a call a bridge call.
 */
export function bridgeToolName(update: { name?: string | null; title?: string | null; rawInput?: unknown }): string | undefined {
  const claude = /^mcp__raw__(.+)$/.exec(update.name ?? "");
  if (claude) return claude[1];
  const input = record(update.rawInput);
  const codex = /^mcp\.raw\.(.+)$/.exec(update.title ?? "");
  return codex && input.server === "raw" && input.tool === codex[1] ? codex[1] : undefined;
}

/** The identity a CLI's own tool gets in Raw's records: never a Raw tool, so no Raw rule or display applies to it. */
export const cliToolIdentity = (kind: ToolKind, name: string) => `cli:${kind}/${name}`;

/**
 * Maps the updates of one CLI conversation to Raw's turn events. A tool call starts once its input is known (adapters
 * first announce a call with empty input) and ends exactly once, at `completed` or `failed`, or through `closeOpen`.
 */
export class AcpUpdateMapper {
  private readonly calls = new Map<string, OpenCall>();
  /** Calls of Raw's own bridge tools: the bridge records them, so the CLI's report of them is not shown twice. */
  private readonly bridged = new Set<string>();

  map(update: SessionUpdate): AcpTurnEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return update.content.type === "text" && update.content.text ? [{ type: "text", text: update.content.text }] : [];
      case "agent_thought_chunk":
        return update.content.type === "text" && update.content.text ? [{ type: "reasoning", text: update.content.text }] : [];
      case "plan":
        return update.entries.length ? [{ type: "reasoning",
          text: `${update.entries.map((entry) => `${entry.status === "completed" ? "[x]" : "[ ]"} ${entry.content}`).join("\n")}\n` }] : [];
      case "usage_update": return [{ type: "context", used: update.used, size: update.size }];
      case "config_option_update": return [{ type: "config", options: update.configOptions }];
      case "notice": return [{ type: "notice", message: update.description ? `${update.title}: ${update.description}` : update.title }];
      case "tool_call": case "tool_call_update": return this.tool(update);
      default: return STATE_UPDATES.has(update.sessionUpdate) ? [] : [{ type: "unknown", kind: update.sessionUpdate }];
    }
  }

  /** Ends every call still open (a cancelled or failed turn), so each started call has exactly one result. */
  closeOpen(code: string, message: string): AcpTurnEvent[] {
    const events: AcpTurnEvent[] = [];
    for (const [id, call] of this.calls) {
      if (!call.started) continue;
      events.push(this.result(id, call, { isError: true, code, content: [{ type: "text", text: message }] }));
    }
    this.calls.clear();
    return events;
  }

  private tool(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>): AcpTurnEvent[] {
    const id = update.toolCallId;
    if (this.bridged.has(id)) return [];
    let call = this.calls.get(id);
    if (!call && bridgeToolName(update) !== undefined) { this.bridged.add(id); return []; }
    if (!call) {
      const title = update.title ?? "Tool";
      call = { name: update.name ?? title, title, kind: KINDS[update.kind ?? ""] ?? "other", arguments: {}, started: false,
        startedAt: performance.now(), output: "", content: [] };
      this.calls.set(id, call);
    }
    if (update.title) call.title = update.title;
    if (update.kind) call.kind = KINDS[update.kind] ?? "other";
    // An update carries only the fields that changed (ACP `ToolCallUpdate`); the others keep their last value.
    if (update.content) call.content = update.content;
    if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
    const input = record(update.rawInput);
    if (Object.keys(input).length) call.arguments = input;
    const meta = record(update._meta);
    const delta = record(meta.terminal_output_delta).data;
    if (typeof delta === "string") call.output += delta;
    const exit = record(meta.terminal_exit);
    if ("exit_code" in exit) call.exitCode = typeof exit.exit_code === "number" ? exit.exit_code : null;
    const events: AcpTurnEvent[] = [];
    const terminal = update.status === "completed" || update.status === "failed";
    if (!call.started && (terminal || update.status === "in_progress" || Object.keys(call.arguments).length)) {
      call.started = true;
      call.startedAt = performance.now();
      events.push({ type: "tool_start", id, name: call.name, arguments: call.arguments, display: this.display(id, call, true) });
    }
    if (terminal) {
      this.calls.delete(id);
      events.push(this.result(id, call, this.toolResult(call, update.status === "failed", call.content, call.rawOutput)));
    }
    return events;
  }

  private display(id: string, call: OpenCall, started: boolean): VisibleToolCall {
    const projected = projectToolCall(call.name, cliToolIdentity(call.kind, call.name), call.arguments, started, { kind: call.kind });
    return { ...projected, id, title: bounded(call.title) };
  }

  private toolResult(call: OpenCall, failed: boolean, content: NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]>,
    rawOutput: unknown): ToolResult {
    const parts: string[] = [];
    for (const item of content) {
      if (item.type === "content" && item.content.type === "text") parts.push(item.content.text);
      else if (item.type === "diff") parts.push(`Edited ${item.path}`);
    }
    if (!parts.length && call.output) parts.push(call.output);
    if (!parts.length && rawOutput !== undefined && rawOutput !== null) parts.push(typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput));
    const exitFailed = typeof call.exitCode === "number" && call.exitCode !== 0;
    return { isError: failed || exitFailed, content: parts.length ? [{ type: "text", text: parts.join("\n") }] : [],
      ...(call.exitCode !== undefined ? { exitCode: call.exitCode } : {}) };
  }

  private result(id: string, call: OpenCall, result: ToolResult): AcpTurnEvent {
    const identity = cliToolIdentity(call.kind, call.name);
    const display = { ...projectToolResult(call.name, identity, result, performance.now() - call.startedAt, { kind: call.kind }), id };
    return { type: "tool_result", id, name: call.name, result, display, call: this.display(id, call, call.started), started: call.started };
  }
}
