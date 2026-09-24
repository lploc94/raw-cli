import { DEFAULT_SYSTEM_PROMPT } from "./llm/prompt.js";
import { randomUUID } from "node:crypto";
import { performCompaction, type CompactOptions, type CompactResult } from "./compact.js";
import { summarizeUsage, type UsageRecord, type UsageSummary } from "./llm/cache.js";
import type { ModelMessage, ModelToolCall, ProviderAdapter, UserInput } from "./llm/types.js";
import { createToolRegistry, type ToolDefinition, type ToolRegistry } from "./tools/registry.js";
import { capResult, errorResult } from "./tools/results.js";
import type { ToolContext } from "./tools/primitives.js";
import type { ToolResult } from "./tools/types.js";

export type AgentState = "idle" | "running" | "cancelling" | "compacting" | "closing" | "closed";
export type RunStatus = "completed" | "max_steps" | "cancelled" | "error";

export interface RunResult {
  status: RunStatus;
  steps: number;
  text?: string;
  code?: string;
  message?: string;
}

export type RunEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: ToolResult }
  | { type: "usage"; raw: unknown }
  | { type: "run_end"; result: RunResult };

export interface AgentOptions {
  provider: ProviderAdapter;
  registry?: ToolRegistry;
  cwd?: string;
  system?: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
  approve?: ToolContext["approve"];
  whitelist?: readonly string[];
}

export class AgentSession {
  private readonly options: Required<Pick<AgentOptions, "provider" | "registry" | "cwd" | "system" | "maxSteps" | "maxOutputBytes" | "requestTimeoutMs" | "autoApprove">> & Pick<AgentOptions, "approve" | "whitelist">;
  private messages: ModelMessage[] = [];
  private currentState: AgentState = "idle";
  private controller: AbortController | undefined;
  private activeRun: Promise<RunResult> | undefined;
  private activeCompact: Promise<CompactResult> | undefined;
  private rawUsage: unknown[] = [];
  private usageEntries: UsageRecord[] = [];
  private originalTask: UserInput | undefined;
  private summaryText: string | undefined;
  private readonly cacheKey = randomUUID();
  private schemaView: readonly ToolDefinition[];
  private schemaRevision = 1;

  constructor(options: AgentOptions) {
    const maxSteps = options.maxSteps ?? 25;
    const maxOutputBytes = options.maxOutputBytes ?? 8192;
    const requestTimeoutMs = options.requestTimeoutMs ?? 120000;
    for (const [name, value] of [["maxSteps", maxSteps], ["maxOutputBytes", maxOutputBytes], ["requestTimeoutMs", requestTimeoutMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || (name === "requestTimeoutMs" && value > 2147483647)) throw new Error(`${name} must be a positive integer within the supported range`);
    }
    this.options = {
      provider: options.provider,
      registry: options.registry ?? createToolRegistry(),
      cwd: options.cwd ?? process.cwd(),
      system: options.system ?? DEFAULT_SYSTEM_PROMPT,
      maxSteps, maxOutputBytes, requestTimeoutMs,
      autoApprove: options.autoApprove ?? true,
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.whitelist !== undefined ? { whitelist: [...options.whitelist] } : {}),
    };
    this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
  }

  get state(): AgentState { return this.currentState; }
  get transcript(): readonly ModelMessage[] { return structuredClone(this.messages); }
  get usageRecords(): readonly unknown[] { return structuredClone(this.rawUsage); }
  get cwd(): string { return this.options.cwd; }
  get toolSchemaRevision(): number { return this.schemaRevision; }
  get toolDefinitions(): readonly ToolDefinition[] { return structuredClone(this.schemaView); }
  stats(): UsageSummary { return summarizeUsage(this.usageEntries); }

  setToolView(whitelist?: readonly string[]): number {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    const known = new Set(this.options.registry.definitions().map((item) => item.name));
    for (const name of whitelist ?? []) if (!known.has(name)) throw new Error(`unknown tool: ${name}`);
    if (whitelist === undefined) delete this.options.whitelist;
    else this.options.whitelist = [...whitelist];
    this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
    return ++this.schemaRevision;
  }

  clear(): void {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    this.messages = [];
    this.originalTask = undefined;
    this.summaryText = undefined;
  }

  setMaxOutputBytes(value: number): void {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxOutputBytes must be a positive integer");
    this.options.maxOutputBytes = value;
  }

  abort(): boolean {
    if (this.currentState !== "running" && this.currentState !== "compacting" && this.currentState !== "cancelling") return false;
    this.currentState = "cancelling";
    this.controller?.abort();
    return true;
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closing";
    this.controller?.abort();
    try {
      if (this.activeRun) await this.activeRun;
      if (this.activeCompact) await this.activeCompact;
    }
    finally { this.currentState = "closed"; }
  }

  compact(options: CompactOptions = {}): Promise<CompactResult> {
    if (this.currentState === "closed" || this.currentState === "closing") return Promise.reject(new Error("agent session is closed"));
    if (this.currentState !== "idle") return Promise.reject(new Error("agent session is busy"));
    const keepRecentTurns = options.keepRecentTurns ?? 2;
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      return Promise.reject(new Error("invalid compaction settings"));
    }
    this.currentState = "compacting";
    const controller = new AbortController();
    this.controller = controller;
    const provider = options.provider ?? this.options.provider;
    const compactUsage: UsageRecord = { provider: provider.profile.provider, raw: undefined };
    let compactUsageIndex: number | undefined;
    const beforeBytes = Buffer.byteLength(JSON.stringify(this.messages), "utf8");
    const snapshot = { messages: structuredClone(this.messages), ...(this.originalTask !== undefined ? { originalTask: this.originalTask } : {}),
      ...(this.summaryText !== undefined ? { previousSummary: this.summaryText } : {}) };
    const task = (async (): Promise<CompactResult> => {
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("compaction aborted"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        const work = await Promise.race([performCompaction(snapshot, provider, {
          keepRecentTurns, maxOutputTokens, timeoutMs: this.options.requestTimeoutMs,
          signal: controller.signal, cacheKey: `${this.cacheKey}:compact`,
          onRequestStart: () => this.usageEntries.push(compactUsage),
          onUsage: (raw) => {
            compactUsage.raw = structuredClone(raw);
            if (compactUsageIndex === undefined) {
              compactUsageIndex = this.rawUsage.push(structuredClone(raw)) - 1;
            } else this.rawUsage[compactUsageIndex] = structuredClone(raw);
          },
        }), aborted]);
        if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
        if (work.replacement && work.summary !== undefined) {
          this.messages = structuredClone(work.replacement);
          this.summaryText = work.summary;
        }
        return work.result;
      } catch (error) {
        if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
        throw error;
      } finally { controller.signal.removeEventListener("abort", onAbort); }
    })().finally(() => {
      this.controller = undefined;
      this.activeCompact = undefined;
      if (this.currentState !== "closing" && this.currentState !== "closed") this.currentState = "idle";
    });
    this.activeCompact = task;
    return task;
  }

  run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    if (this.currentState === "closed" || this.currentState === "closing") return Promise.reject(new Error("agent session is closed"));
    if (this.currentState !== "idle") return Promise.reject(new Error("agent session is busy"));
    this.currentState = "running";
    const controller = new AbortController();
    this.controller = controller;
    const running = this.execute(input, controller, onEvent).finally(() => {
      this.controller = undefined;
      this.activeRun = undefined;
      if (this.currentState !== "closing" && this.currentState !== "closed") this.currentState = "idle";
    });
    this.activeRun = running;
    return running;
  }

  private async execute(input: UserInput, controller: AbortController, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    let steps = 0;
    let observerError: Error | undefined;
    let ended = false;
    const emit = (event: RunEvent) => {
      if (observerError) return;
      try { onEvent?.(structuredClone(event)); }
      catch (error) {
        observerError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    };
    const finish = (result: RunResult): RunResult => {
      if (!ended) {
        ended = true;
        try { onEvent?.(structuredClone({ type: "run_end", result })); }
        catch { /* observer failure cannot emit a second terminal event */ }
      }
      return result;
    };
    const interrupted = (): RunResult => observerError
      ? { status: "error", steps, code: "event_handler_error", message: observerError.message }
      : { status: "cancelled", steps };
    const cancelled = (call: ModelToolCall): ToolResult => capResult(errorResult("cancelled", `tool ${call.name} cancelled`), this.options.maxOutputBytes);
    const appendResult = (call: ModelToolCall, result: ToolResult) => {
      this.messages.push({ role: "tool", callId: call.id, name: call.name, result: structuredClone(result) });
      emit({ type: "tool_result", id: call.id, name: call.name, result });
    };
    if (this.originalTask === undefined) this.originalTask = structuredClone(input);
    this.messages.push({ role: "user", content: structuredClone(input) });
    try {
      while (steps < this.options.maxSteps) {
        if (controller.signal.aborted) return finish(interrupted());
        steps++;
        const usageEntry: UsageRecord = { provider: this.options.provider.profile.provider, raw: undefined };
        this.usageEntries.push(usageEntry);
        let usageIndex: number | undefined;
        const recordUsage = (raw: unknown) => {
          if (controller.signal.aborted) return;
          usageEntry.raw = structuredClone(raw);
          if (usageIndex === undefined) usageIndex = this.rawUsage.push(structuredClone(raw)) - 1;
          else this.rawUsage[usageIndex] = structuredClone(raw);
          emit({ type: "usage", raw });
        };
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("provider request aborted"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        let turn;
        try {
          turn = await Promise.race([this.options.provider.generate({
            system: this.options.system,
            messages: this.messages,
            tools: this.schemaView,
            timeoutMs: this.options.requestTimeoutMs,
            cacheKey: this.cacheKey,
            signal: controller.signal,
            onTextDelta: (text) => { if (!controller.signal.aborted) emit({ type: "text_delta", text }); },
            onUsage: recordUsage,
          }), aborted]);
        } finally { controller.signal.removeEventListener("abort", onAbort); }
        if (controller.signal.aborted) return finish(interrupted());
        if (turn.usage !== undefined && usageIndex === undefined) recordUsage(turn.usage);
        if (controller.signal.aborted) return finish(interrupted());
        if (new Set(turn.toolCalls.map((call) => call.id)).size !== turn.toolCalls.length || turn.toolCalls.some((call) => !call.id || !call.name)) {
          throw new Error("provider returned invalid tool call linkage");
        }
        if (!turn.toolCalls.length) {
          this.messages.push(structuredClone({ role: "assistant", text: turn.text, toolCalls: [], ...(turn.opaque !== undefined ? { opaque: turn.opaque } : {}) }));
          return finish({ status: "completed", steps, text: turn.text });
        }
        if (steps >= this.options.maxSteps) return finish({ status: "max_steps", steps, code: "max_steps", message: "tool calls require another inference step" });
        this.messages.push(structuredClone({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, ...(turn.opaque !== undefined ? { opaque: turn.opaque } : {}) }));
        for (const call of turn.toolCalls) emit({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
        for (let index = 0; index < turn.toolCalls.length; index++) {
          const call = turn.toolCalls[index]!;
          if (controller.signal.aborted) {
            for (const remaining of turn.toolCalls.slice(index)) appendResult(remaining, cancelled(remaining));
            return finish(interrupted());
          }
          const result = call.argumentError
            ? capResult(errorResult("invalid_arguments", call.argumentError), this.options.maxOutputBytes)
            : await this.options.registry.dispatch(call.name, call.arguments, {
              cwd: this.options.cwd,
              maxOutputBytes: this.options.maxOutputBytes,
              autoApprove: this.options.autoApprove,
              ...(this.options.approve ? { approve: this.options.approve } : {}),
              ...(this.options.whitelist !== undefined ? { whitelist: this.options.whitelist } : {}),
              signal: controller.signal,
              toolCallId: call.id,
              onStart: (name, args) => emit({ type: "tool_start", id: call.id, name, arguments: args }),
            });
          appendResult(call, result);
          if (result.code === "approval_required") {
            for (const remaining of turn.toolCalls.slice(index + 1)) appendResult(remaining, cancelled(remaining));
            return finish({ status: "error", steps, code: "approval_required", message: "tool approval required" });
          }
          if (controller.signal.aborted || result.code === "aborted") {
            for (const remaining of turn.toolCalls.slice(index + 1)) appendResult(remaining, cancelled(remaining));
            return finish(interrupted());
          }
        }
      }
      return finish({ status: "max_steps", steps, code: "max_steps" });
    } catch (error) {
      if (controller.signal.aborted) return finish(interrupted());
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "provider_error";
      return finish({ status: "error", steps, code, message: (error as Error).message });
    }
  }
}

export function createAgent(options: AgentOptions): AgentSession { return new AgentSession(options); }
