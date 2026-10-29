import { projectToolCall, projectToolResult, type VisibleToolCall } from "../sessions/visible.js";
import type { ToolKind } from "../tools/display.js";
import type { ToolResult } from "../tools/types.js";
import { cliToolIdentity, type AcpTurnEvent } from "./acp-events.js";

/** What one agy stream-json line means to a turn: the events of `AcpTurnEvent`, plus the conversation and the result. */
export type AgyTurnEvent = AcpTurnEvent
  | { type: "conversation"; id: string }
  | { type: "result"; ok: boolean; response: string; error: string; usage?: Record<string, number> };

interface OpenStep { name: string; title: string; kind: ToolKind; arguments: Record<string, unknown>; startedAt: number }

const TITLE_CHARS = 120;
/** agy 1.4.10 tool names by what they do; any other tool is `other`. */
const KINDS: Readonly<Record<string, ToolKind>> = {
  run_command: "execute", view_file: "read", list_dir: "read", grep_search: "search", find_by_name: "search",
  write_to_file: "edit", replace_file_content: "edit", multi_replace_file_content: "edit", search_web: "fetch", read_url_content: "fetch",
};
/** Step types that carry nothing for the chat: the echo of the user's input, and the error a `result` reports again. */
const SILENT_STEPS = new Set(["user_input", "error_message"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const bounded = (line: string) => {
  const flat = line.replace(/\s+/g, " ").trim();
  return [...flat].length <= TITLE_CHARS ? flat : `${[...flat].slice(0, TITLE_CHARS - 1).join("")}…`;
};
/** What a tool step is about, from the parameters agy's own tools take. */
const subject = (parameters: Record<string, unknown>) =>
  text(parameters.CommandLine) || text(parameters.TargetFile) || text(parameters.AbsolutePath) || text(parameters.Query)
  || text(parameters.SearchPath) || text(parameters.Url);
/** `run_command` reports its exit as the first line of its output: "Command exited with code N." */
const EXIT_LINE = /^Command exited with code (-?\d+)\./;

/** Usage of a `result` in ACP's `Usage` shape: agy reports input without the cached part, and thinking beside output. */
function usageOf(value: unknown): Record<string, number> | undefined {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : undefined;
  const input = count("input_tokens");
  if (input === undefined) return undefined;
  const output = (count("output_tokens") ?? 0) + (count("thinking_tokens") ?? 0);
  return { inputTokens: input, outputTokens: output, cachedReadTokens: count("cache_read_tokens") ?? 0,
    ...(count("thinking_tokens") !== undefined ? { thoughtTokens: count("thinking_tokens")! } : {}),
    totalTokens: input + (count("cache_read_tokens") ?? 0) + output };
}

/**
 * Maps the stream-json lines of one agy turn to Raw's turn events (agy 1.4.10: `init`, `step_update`, `result`). A tool
 * step starts when agy reports it ACTIVE and ends once, at its first other state or through `closeOpen`.
 */
export class AgyEventMapper {
  private readonly steps = new Map<string, OpenStep>();

  map(line: unknown): AgyTurnEvent[] {
    const event = record(line);
    if (event.event === "init") {
      const id = text(event.conversation_id);
      return id ? [{ type: "conversation", id }] : [];
    }
    if (event.event === "result") {
      const result = record(event.result);
      const usage = usageOf(result.usage);
      const events: AgyTurnEvent[] = [];
      const id = text(result.conversation_id);
      if (id) events.push({ type: "conversation", id });
      events.push({ type: "result", ok: result.status === "SUCCESS", response: text(result.response),
        error: text(result.error).trim() || text(result.status) || "unknown error", ...(usage ? { usage } : {}) });
      return events;
    }
    if (event.event !== "step_update") return [{ type: "unknown", kind: typeof event.event === "string" ? event.event : "line" }];
    const step = record(event.step_update);
    const type = text(step.step_type);
    if (type === "agent_response") return text(step.text_delta) ? [{ type: "text", text: text(step.text_delta) }] : [];
    if (type === "system_message") return text(step.text_delta) ? [{ type: "reasoning", text: text(step.text_delta) }] : [];
    if (type === "tool") return this.tool(`${text(step.conversation_id)}:${String(step.step_index)}`, step);
    return SILENT_STEPS.has(type) ? [] : [{ type: "unknown", kind: `step_update ${type || "untyped"}` }];
  }

  /** Ends every step still open (a cancelled or failed turn), so each started call has exactly one result. */
  closeOpen(code: string, message: string): AgyTurnEvent[] {
    const events = [...this.steps].map(([id, step]) => this.result(id, step, { isError: true, code, content: [{ type: "text", text: message }] }));
    this.steps.clear();
    return events;
  }

  private tool(id: string, step: Record<string, unknown>): AgyTurnEvent[] {
    const info = record(step.tool_info);
    const events: AgyTurnEvent[] = [];
    let open = this.steps.get(id);
    if (!open) {
      const name = text(step.tool_name) || text(info.name) || "tool";
      const parameters = record(info.parameters);
      open = { name, title: bounded(subject(parameters) || name), kind: KINDS[name] ?? "other", arguments: parameters, startedAt: performance.now() };
      this.steps.set(id, open);
      events.push({ type: "tool_start", id, name, arguments: open.arguments, display: this.display(id, open) });
    }
    if (step.state === "ACTIVE") return events;
    this.steps.delete(id);
    const output = text(info.output);
    const exit = EXIT_LINE.exec(output);
    const exitCode = exit ? Number(exit[1]) : undefined;
    const failed = step.state !== "DONE" || (exitCode !== undefined && exitCode !== 0);
    const message = output || (step.state === "DONE" ? "" : `${open.name} ended ${String(step.state)}`);
    events.push(this.result(id, open, { isError: failed, content: message ? [{ type: "text", text: message }] : [],
      ...(exitCode !== undefined ? { exitCode } : {}) }));
    return events;
  }

  private display(id: string, step: OpenStep): VisibleToolCall {
    return { ...projectToolCall(step.name, cliToolIdentity(step.kind, step.name), step.arguments, true, { kind: step.kind }), id, title: step.title };
  }

  private result(id: string, step: OpenStep, result: ToolResult): AgyTurnEvent {
    const display = { ...projectToolResult(step.name, cliToolIdentity(step.kind, step.name), result, performance.now() - step.startedAt,
      { kind: step.kind }), id };
    return { type: "tool_result", id, name: step.name, result, display, call: this.display(id, step), started: true };
  }
}
