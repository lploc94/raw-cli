import type { AgentState, RunEvent, RunResult } from "../../src/agent.js";
import type { PanelActionRequest, SessionAgent } from "../../src/backends/types.js";
import type { CompactResult } from "../../src/compact.js";
import { summarizeUsage } from "../../src/llm/cache.js";
import type { ModelMessage, UserInput } from "../../src/llm/types.js";
import type { ToolDisplay } from "../../src/tools/display.js";

/**
 * A session agent that is not Raw's loop: each turn emits a scripted tool call and answer, or waits until aborted
 * when the input contains "wait". It records every call so tests can see what the host asked of it.
 */
export class FakeSessionAgent implements SessionAgent {
  currentState: AgentState = "idle";
  readonly calls: string[] = [];
  private messages: ModelMessage[] = [];
  private stop: (() => void) | undefined;

  constructor(private readonly label = "fake") {}

  get state(): AgentState { return this.currentState; }
  get transcript(): readonly ModelMessage[] { return structuredClone(this.messages); }
  async start(source: "create" | "resume"): Promise<void> { this.calls.push(`start:${source}`); }

  async run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    this.calls.push(`run:${text}`);
    this.currentState = "running";
    onEvent?.({ type: "input_committed" });
    this.messages.push({ role: "user", content: text });
    if (text.includes("wait")) {
      await new Promise<void>((resolve) => { this.stop = resolve; });
      this.currentState = "idle";
      const result: RunResult = { status: "cancelled", steps: 0 };
      onEvent?.({ type: "run_end", result });
      return result;
    }
    const args = { command: "echo hi" };
    onEvent?.({ type: "tool_start", id: "call-1", name: "Terminal", arguments: args });
    onEvent?.({ type: "tool_result", id: "call-1", name: "Terminal", result: { isError: false, content: [{ type: "text", text: "hi" }] } });
    const answer = `${this.label} answered ${text}`;
    onEvent?.({ type: "text_delta", text: answer });
    this.messages.push({ role: "assistant", text: answer, toolCalls: [] });
    this.currentState = "idle";
    const result: RunResult = { status: "completed", steps: 1, text: answer };
    onEvent?.({ type: "run_end", result });
    return result;
  }

  async runPanelAction(request: PanelActionRequest, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    this.calls.push(`panel:${request.panel}:${request.action}`);
    const result: RunResult = { status: "completed", steps: 0 };
    onEvent?.({ type: "run_end", result });
    return result;
  }

  async compact(): Promise<CompactResult> { this.calls.push("compact"); return { status: "noop" }; }
  abort(): boolean {
    this.calls.push("abort");
    if (!this.stop) return false;
    this.stop(); this.stop = undefined; return true;
  }
  async close(): Promise<void> { this.calls.push("close"); this.currentState = "closed"; }
  stats(): ReturnType<SessionAgent["stats"]> { return summarizeUsage([]); }
  contextUsage(): { tokens: number; source: "provider"; window: number } { return { tokens: 1200, source: "provider", window: 200000 }; }
  toolIdentity(name: string): string { return `cli:${name}`; }
  toolDisplay(): ToolDisplay | undefined { return undefined; }
}
