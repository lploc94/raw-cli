import { DEFAULT_SYSTEM_PROMPT } from "./llm/prompt.js";
import { randomUUID } from "node:crypto";
import { estimateRequestTokens, performCompaction, type CompactOptions, type CompactResult } from "./compact.js";
import { normalizeUsage, summarizeUsage, type UsageRecord, type UsageSummary } from "./llm/cache.js";
import type { CompactSettings } from "./config.js";
import { renderUserInput, type ModelMessage, type ModelToolCall, type ProviderAdapter, type UserInput } from "./llm/types.js";
import { ToolRegistry, type ToolDefinition } from "./tools/registry.js";
import { capResult, errorResult } from "./tools/results.js";
import type { ToolContext } from "./tools/primitives.js";
import type { ToolResult } from "./tools/types.js";
import type { SessionOwner, SessionStore } from "./sessions/store.js";
import type { SkillVisibility } from "./sessions/store.js";
import type { SelectedSkill } from "./skills/contract.js";
import { isEphemeralPeerAlias, validateStoredAgentState } from "./sessions/restore.js";
import { acpUpdate } from "./sessions/display.js";
import type { AgentMetadata, VisibleRecord } from "./sessions/store.js";
import { projectToolCall, projectToolResult, type VisibleToolCall, type VisibleToolResult } from "./sessions/visible.js";

export type AgentState = "idle" | "running" | "cancelling" | "compacting" | "closing" | "closed";

function loadedSkillNames(messages: readonly ModelMessage[]): Set<string> {
  const calls = new Map<string, string>();
  const loaded = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls) {
      if (call.name === "load_skill" && typeof call.arguments.name === "string") calls.set(call.id, call.arguments.name);
    }
    if (message.role === "tool" && message.name === "load_skill" && !message.result.isError) {
      const name = calls.get(message.callId);
      if (name) loaded.add(name);
    }
  }
  return loaded;
}
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
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown>; display?: VisibleToolCall }
  | { type: "tool_result"; id: string; name: string; result: ToolResult; display?: VisibleToolResult }
  | { type: "usage"; raw: unknown }
  | { type: "compact_start"; estimatedTokens: number }
  | { type: "compact_end"; result: CompactResult }
  | { type: "run_end"; result: RunResult };

export interface AgentOptions {
  provider: ProviderAdapter;
  registry?: ToolRegistry;
  toolSourceDigest?: string;
  selectedSkills?: readonly SelectedSkill[];
  cwd?: string;
  system?: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
  approve?: ToolContext["approve"];
  whitelist?: readonly string[];
  compact?: Readonly<CompactSettings>;
  persistence?: { store: SessionStore; sessionId: string; surface: "cli" | "acp"; owner?: SessionOwner };
}

export class AgentSession {
  private readonly options: Required<Pick<AgentOptions, "provider" | "registry" | "cwd" | "system" | "maxSteps" | "maxOutputBytes" | "requestTimeoutMs" | "autoApprove">> & Pick<AgentOptions, "approve" | "whitelist" | "compact">;
  private messages: ModelMessage[] = [];
  private currentState: AgentState = "idle";
  private controller: AbortController | undefined;
  private activeRun: Promise<RunResult> | undefined;
  private activeCompact: Promise<CompactResult> | undefined;
  private rawUsage: unknown[] = [];
  private usageEntries: UsageRecord[] = [];
  private originalTask: UserInput | undefined;
  private summaryText: string | undefined;
  private cacheKey: string = randomUUID();
  private schemaView: readonly ToolDefinition[];
  private contextGenerationRevision = 1;
  private readonly selectedSkills: readonly SelectedSkill[];
  private skillVisibility: SkillVisibility = { listed: false, loaded: [] };
  private tokenCalibration = 1;
  private persistence: { store: SessionStore; sessionId: string; owner: SessionOwner; surface: "cli" | "acp" } | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private persistenceFailed = false;
  private persistenceError: Error | undefined;

  constructor(options: AgentOptions) {
    this.selectedSkills = Object.freeze((options.selectedSkills ?? []).map((skill) => Object.freeze({ ...skill })));
    const maxSteps = options.maxSteps ?? 25;
    const maxOutputBytes = options.maxOutputBytes ?? 8192;
    const requestTimeoutMs = options.requestTimeoutMs ?? 120000;
    for (const [name, value] of [["maxSteps", maxSteps], ["maxOutputBytes", maxOutputBytes], ["requestTimeoutMs", requestTimeoutMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || (name === "requestTimeoutMs" && value > 2147483647)) throw new Error(`${name} must be a positive integer within the supported range`);
    }
    if (options.compact !== undefined && (!Number.isSafeInteger(options.compact.keepRecentTurns)
      || options.compact.keepRecentTurns < 0 || !Number.isSafeInteger(options.compact.maxOutputTokens)
      || options.compact.maxOutputTokens < 1)) throw new Error("invalid compaction settings");
    if (options.compact?.triggerTokens !== undefined) {
      const context = options.provider.modelConfig.contextWindow;
      const output = options.provider.modelConfig.request?.maxOutputTokens ?? options.provider.modelConfig.maxOutputTokens ?? 1024;
      if (!Number.isSafeInteger(context) || context! < 1 || !Number.isSafeInteger(options.compact.triggerTokens)
        || options.compact.triggerTokens < 1 || options.compact.triggerTokens >= context! - output - Math.max(64, Math.ceil(context! * 0.05))) {
        throw new Error("auto compact trigger requires a valid context window and output reserve");
      }
    }
    this.options = {
      provider: options.provider,
      registry: options.registry ?? new ToolRegistry(),
      cwd: options.cwd ?? process.cwd(),
      system: options.system ?? DEFAULT_SYSTEM_PROMPT,
      maxSteps, maxOutputBytes, requestTimeoutMs,
      autoApprove: options.autoApprove ?? true,
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.whitelist !== undefined ? { whitelist: [...options.whitelist] } : {}),
      ...(options.compact !== undefined ? { compact: { ...options.compact } } : {}),
    };
    this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
    if (options.persistence) {
      const { store, sessionId, surface } = options.persistence;
      const owner = options.persistence.owner ?? store.claimSession(sessionId);
      try {
        const savedView = store.getStoredToolView(sessionId);
        if (savedView && (options.whitelist === undefined || (surface === "acp" && savedView.explicit))) {
          if (savedView.selection === null) delete this.options.whitelist;
          else {
            const known = new Set(this.options.registry.definitions().map((item) => item.name));
            if (surface === "acp") {
              for (const name of savedView.selection) {
                if (!known.has(name) && !isEphemeralPeerAlias(name)) throw new Error(`saved tool selection unavailable or denied: ${name}`);
              }
              this.options.whitelist = savedView.selection.filter((name) => known.has(name));
            } else this.options.whitelist = [...savedView.selection];
          }
          this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
        }
        const saved = store.initializeAgent(sessionId, owner, {
          cwd: this.options.cwd, system: this.options.system, modelConfig: this.options.provider.modelConfig,
          toolDefinitions: this.schemaView, selectedTools: this.options.whitelist ?? null, cacheKey: this.cacheKey,
          ...(options.toolSourceDigest ? { toolSourceDigest: options.toolSourceDigest } : {}),
          selectedSkills: this.selectedSkills,
        });
        validateStoredAgentState(saved);
        this.messages = structuredClone(saved.messages);
        this.cacheKey = saved.cacheKey;
        this.originalTask = saved.originalTask;
        this.summaryText = saved.summaryText;
        this.rawUsage = structuredClone(saved.rawUsage);
        this.usageEntries = structuredClone(saved.usageEntries);
        this.tokenCalibration = saved.tokenCalibration;
        this.contextGenerationRevision = saved.contextRevision;
        this.skillVisibility = saved.skillVisibility;
        this.persistence = { store, sessionId, owner, surface };
        this.heartbeat = setInterval(() => {
          try { store.renewSession(sessionId, owner); }
          catch (error) {
            this.persistenceFailed = true;
            this.persistenceError = error instanceof Error ? error : new Error(String(error));
            this.controller?.abort();
          }
        }, 5_000);
        this.heartbeat.unref();
      } catch (error) {
        store.releaseSession(sessionId, owner);
        throw error;
      }
    }
  }

  get state(): AgentState { return this.currentState; }
  get transcript(): readonly ModelMessage[] { return structuredClone(this.messages); }
  get usageRecords(): readonly unknown[] { return structuredClone(this.rawUsage); }
  get cwd(): string { return this.options.cwd; }
  get contextRevision(): number { return this.contextGenerationRevision; }
  get toolDefinitions(): readonly ToolDefinition[] { return structuredClone(this.schemaView); }
  toolIdentity(name: string): string | undefined { return this.options.registry.canonicalIdentity(name); }
  stats(): UsageSummary { return summarizeUsage(this.usageEntries); }
  estimatedContextTokens(): number {
    return Math.ceil(estimateRequestTokens(this.options.system, this.messages, this.schemaView) * this.tokenCalibration);
  }

  private durable<T>(operation: (store: SessionStore, sessionId: string, owner: SessionOwner) => T): T | undefined {
    const binding = this.persistence;
    if (!binding) return undefined;
    try { return operation(binding.store, binding.sessionId, binding.owner); }
    catch (error) {
      this.persistenceFailed = true;
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
      this.controller?.abort();
      throw error;
    }
  }

  private commitMessage(message: ModelMessage, metadata: AgentMetadata = {}, display: readonly VisibleRecord[] = []): void {
    this.durable((store, sessionId, owner) => store.appendAgentMessage(sessionId, owner, message, metadata, display));
    this.messages.push(structuredClone(message));
  }

  private recordVisible(kind: string, payload: Record<string, unknown>, status = "complete"): void {
    this.durable((store, sessionId, owner) => store.appendOwnedHistory(sessionId, owner, kind, payload, status));
  }

  setToolView(whitelist?: readonly string[]): number {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    const known = new Set(this.options.registry.definitions().map((item) => item.name));
    for (const name of whitelist ?? []) if (!known.has(name)) throw new Error(`unknown tool: ${name}`);
    const next = this.options.registry.definitions(whitelist);
    if (JSON.stringify(this.options.whitelist ?? null) === JSON.stringify(whitelist ?? null)
      && JSON.stringify(this.schemaView) === JSON.stringify(next)) return this.contextGenerationRevision;
    const nextKey = randomUUID();
    if (this.persistence) this.persistence.store.updateAgentToolView(this.persistence.sessionId, this.persistence.owner,
      whitelist ?? null, next, this.contextGenerationRevision + 1, nextKey, this.persistence.surface === "acp");
    if (whitelist === undefined) delete this.options.whitelist;
    else this.options.whitelist = [...whitelist];
    this.schemaView = Object.freeze(next);
    this.cacheKey = nextKey;
    return ++this.contextGenerationRevision;
  }

  clear(): void {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    if (this.persistence) this.persistence.store.clearAgentContext(this.persistence.sessionId, this.persistence.owner);
    this.messages = [];
    this.originalTask = undefined;
    this.summaryText = undefined;
    this.skillVisibility = { listed: false, loaded: [] };
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

  private async compactWork(provider: ProviderAdapter, keepRecentTurns: number, maxOutputTokens: number,
    controller: AbortController, onUsage?: (raw: unknown) => void): Promise<CompactResult> {
    const beforeBytes = Buffer.byteLength(JSON.stringify(this.messages), "utf8");
    const snapshot = { messages: structuredClone(this.messages), ...(this.originalTask !== undefined ? { originalTask: this.originalTask } : {}),
      ...(this.summaryText !== undefined ? { previousSummary: this.summaryText } : {}) };
    const entries = new Map<number, { entry: UsageRecord; rawIndex?: number }>();
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
        onRequestStart: (index) => {
          const entry: UsageRecord = { method: provider.modelConfig.method, provider: provider.modelConfig.provider, raw: undefined };
          entries.set(index, { entry });
          this.usageEntries.push(entry);
          this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner,
            { rawUsage: this.rawUsage, usageEntries: this.usageEntries }));
        },
        onUsage: (index, raw) => {
          if (controller.signal.aborted) return;
          const current = entries.get(index);
          if (!current) return;
          current.entry.raw = structuredClone(raw);
          if (current.rawIndex === undefined) current.rawIndex = this.rawUsage.push(structuredClone(raw)) - 1;
          else this.rawUsage[current.rawIndex] = structuredClone(raw);
          this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner,
            { rawUsage: this.rawUsage, usageEntries: this.usageEntries }));
          onUsage?.(raw);
        },
      }), aborted]);
      if (this.persistenceError) throw this.persistenceError;
      if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
      if (work.replacement && work.summary !== undefined) {
        const retained = loadedSkillNames(work.replacement);
        const selectedNames = new Set(this.selectedSkills.map((skill) => skill.name));
        const missing = this.skillVisibility.loaded.filter((name) => selectedNames.has(name) && !retained.has(name));
        const priorNotices = work.replacement.flatMap((message) => message.role === "user"
          && typeof message.content === "string" && message.content.startsWith("[Raw skill reload notice]")
          ? [message.content] : []).join("\n");
        const uncovered = missing.filter((name) => !priorNotices.includes(name)).sort();
        const notice = uncovered.length
          ? `[Raw skill reload notice] Loaded skill content was removed by compaction: ${uncovered.join(", ")}. Call load_skill again before relying on earlier instructions.`
          : undefined;
        const replacement: ModelMessage[] = [...work.replacement,
          ...(notice ? [{ role: "user" as const, content: notice }] : [])];
        const finalBytes = Buffer.byteLength(JSON.stringify(replacement), "utf8");
        if (finalBytes >= beforeBytes) return { status: "not_smaller", beforeBytes, afterBytes: finalBytes };
        this.durable((store, sessionId, owner) => store.replaceAgentContext(sessionId, owner, replacement,
          { summaryText: work.summary!, rawUsage: this.rawUsage, usageEntries: this.usageEntries,
            tokenCalibration: this.tokenCalibration, ...(notice ? { skillNotice: notice } : {}) }));
        this.messages = structuredClone(replacement);
        this.summaryText = work.summary;
        return { ...work.result, afterBytes: finalBytes };
      }
      return work.result;
    } catch (error) {
      if (this.persistenceError) throw this.persistenceError;
      if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
      throw error;
    } finally { controller.signal.removeEventListener("abort", onAbort); }
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closing";
    this.controller?.abort();
    try {
      if (this.activeRun) await this.activeRun;
      if (this.activeCompact) await this.activeCompact;
    }
    finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.persistence) this.persistence.store.releaseSession(this.persistence.sessionId, this.persistence.owner);
      this.currentState = "closed";
    }
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
    this.heartbeat?.ref();
    const controller = new AbortController();
    this.controller = controller;
    const task = this.compactWork(options.provider ?? this.options.provider, keepRecentTurns, maxOutputTokens, controller).finally(() => {
      this.controller = undefined;
      this.activeCompact = undefined;
      this.heartbeat?.unref();
      if (this.currentState !== "closing" && this.currentState !== "closed") this.currentState = "idle";
    });
    this.activeCompact = task;
    return task;
  }

  run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    if (this.currentState === "closed" || this.currentState === "closing") return Promise.reject(new Error("agent session is closed"));
    if (this.currentState !== "idle") return Promise.reject(new Error("agent session is busy"));
    if (this.persistenceFailed) return Promise.reject(new Error("session persistence failed; close and resume to recover"));
    this.currentState = "running";
    this.heartbeat?.ref();
    const controller = new AbortController();
    this.controller = controller;
    const running = this.execute(input, controller, onEvent).finally(() => {
      this.controller = undefined;
      this.activeRun = undefined;
      this.heartbeat?.unref();
      if (this.currentState !== "closing" && this.currentState !== "closed") this.currentState = "idle";
    });
    this.activeRun = running;
    return running;
  }

  private async execute(input: UserInput, controller: AbortController, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    let steps = 0;
    let observerError: Error | undefined;
    let ended = false;
    const visibleSegments: Array<{ kind: "assistant" | "reasoning"; text: string }> = [];
    const appendVisible = (kind: "assistant" | "reasoning", text: string) => {
      if (!text) return;
      const last = visibleSegments.at(-1);
      if (last?.kind === kind) last.text += text;
      else visibleSegments.push({ kind, text });
    };
    const startedCalls = new Set<string>();
    const startedAt = new Map<string, number>();
    const emit = (event: RunEvent) => {
      if (observerError) return;
      try {
        onEvent?.(structuredClone(event));
        if (event.type === "text_delta") appendVisible("assistant", event.text);
        else if (event.type === "reasoning_delta") appendVisible("reasoning", event.text);
        else if (event.type === "tool_start" && this.persistence?.surface === "cli") {
          const display = projectToolCall(event.name, this.toolIdentity(event.name), event.arguments, true);
          this.recordVisible("tool_call", { display: { ...display, id: event.id } });
          startedCalls.add(event.id);
          startedAt.set(event.id, performance.now());
        }
        else if (this.persistence?.surface === "acp" && ["tool_start", "compact_start", "compact_end"].includes(event.type)) {
          const update = acpUpdate(event);
          if (update) this.recordVisible("acp_update", { update });
        } else if (this.persistence?.surface === "cli" && event.type === "compact_start") {
          this.recordVisible("status", { text: `raw: compacting context (${event.estimatedTokens} estimated input tokens)` });
        } else if (this.persistence?.surface === "cli" && event.type === "compact_end") {
          this.recordVisible("status", { text: `raw: compact ${event.result.status}` });
        }
      }
      catch (error) {
        observerError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    };
    const visibleMessage = (fallbackText = "", status = "complete"): VisibleRecord[] => {
      const segments = visibleSegments.splice(0);
      if (fallbackText && !segments.some((segment) => segment.kind === "assistant")) {
        segments.push({ kind: "assistant", text: fallbackText });
      }
      if (this.persistence?.surface === "acp") {
        const text = segments.filter((segment) => segment.kind === "assistant").map((segment) => segment.text).join("");
        return text ? [{ kind: "assistant", payload: { update: acpUpdate({ type: "text_delta", text }) }, status }] : [];
      }
      return segments.map((segment) => ({ kind: segment.kind, payload: { text: segment.text }, status }));
    };
    const finish = (result: RunResult): RunResult => {
      if (!ended) {
        ended = true;
        let finalResult = result;
        const status = result.status === "cancelled" ? "interrupted" : result.status === "error" ? "error" : "complete";
        if (!this.persistenceError) {
          try { for (const item of visibleMessage("", status)) this.recordVisible(item.kind, item.payload, item.status); }
          catch (error) {
            finalResult = { status: "error", steps, code: "persistence_error",
              message: error instanceof Error ? error.message : String(error) };
          }
        }
        try { onEvent?.(structuredClone({ type: "run_end", result: finalResult })); }
        catch { /* observer failure cannot emit a second terminal event */ }
        return finalResult;
      }
      return result;
    };
    const interrupted = (): RunResult => this.persistenceError
      ? { status: "error", steps, code: "persistence_error", message: this.persistenceError.message }
      : observerError ? { status: "error", steps, code: "event_handler_error", message: observerError.message }
      : { status: "cancelled", steps };
    const cancelled = (call: ModelToolCall): ToolResult => capResult(errorResult("cancelled", `tool ${call.name} cancelled`), this.options.maxOutputBytes);
    const appendResult = (call: ModelToolCall, result: ToolResult) => {
      let visibility: SkillVisibility | undefined;
      if (!result.isError && call.name === "list_skills" && this.selectedSkills.length) {
        visibility = { ...this.skillVisibility, listed: true };
      } else if (!result.isError && call.name === "load_skill" && typeof call.arguments.name === "string"
        && this.selectedSkills.some((skill) => skill.name === call.arguments.name)) {
        visibility = { ...this.skillVisibility, loaded: [...new Set([...this.skillVisibility.loaded, call.arguments.name])] };
      }
      const publicResult: ToolResult = { ...result, content: result.content.map((block) => block.type === "image"
        ? { type: "text", text: `[${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes]` }
        : block) };
      const display: VisibleRecord[] = [];
      const identity = this.toolIdentity(call.name);
      if (this.persistence?.surface === "cli" && !startedCalls.has(call.id)) {
        display.push({ kind: "tool_call", payload: {
          display: { ...projectToolCall(call.name, identity, call.arguments, false), id: call.id },
        } });
      }
      const projected = { ...projectToolResult(call.name, identity, publicResult,
        startedAt.has(call.id) ? performance.now() - startedAt.get(call.id)! : undefined), id: call.id };
      if (this.persistence?.surface === "cli") display.push({ kind: "tool_result", payload: { display: projected } });
      if (this.persistence?.surface === "acp") display.push({ kind: "tool_result", payload: {
        update: acpUpdate({ type: "tool_result", id: call.id, name: call.name, result: publicResult }),
      } });
      this.commitMessage({ role: "tool", callId: call.id, name: call.name, result: structuredClone(result) },
        visibility ? { skillVisibility: visibility } : {}, display);
      if (visibility) this.skillVisibility = visibility;
      emit({ type: "tool_result", id: call.id, name: call.name, result: publicResult, display: projected });
    };
    const firstTask = this.originalTask === undefined;
    let autoCompacted = false;
    try {
      this.commitMessage({ role: "user", content: structuredClone(input) }, firstTask ? { originalTask: input } : {},
        [{ kind: "user", payload: { input: structuredClone(input) } }]);
      if (firstTask) {
        this.originalTask = structuredClone(input);
        this.durable((store, sessionId, owner) => store.setTitleFromPrompt(sessionId, owner, renderUserInput(input)));
      }
      while (steps < this.options.maxSteps) {
        if (controller.signal.aborted) return finish(interrupted());
        let requestEstimate = 0;
        let baseEstimate = 0;
        const compact = this.options.compact;
        if (compact?.triggerTokens !== undefined) {
          const modelConfig = this.options.provider.modelConfig;
          const context = modelConfig.contextWindow!;
          const outputReserve = modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens ?? 1024;
          const inputBudget = context - outputReserve - Math.max(64, Math.ceil(context * 0.05));
          const estimate = () => {
            baseEstimate = estimateRequestTokens(this.options.system, this.messages, this.schemaView);
            return Math.ceil(baseEstimate * this.tokenCalibration);
          };
          requestEstimate = estimate();
          if (requestEstimate >= compact.triggerTokens && !autoCompacted) {
            emit({ type: "compact_start", estimatedTokens: requestEstimate });
            if (controller.signal.aborted) return finish(interrupted());
            let compactResult: CompactResult;
            const history = this.summaryText ? this.messages.slice(1) : this.messages;
            const starts = history.flatMap((message, index) => message.role === "user" ? [index] : []);
            let keep = Math.min(compact.keepRecentTurns, starts.length);
            if (keep === starts.length && history.length > starts.length) keep = Math.max(0, keep - 1);
            const summaryPlaceholder = "x".repeat(Math.min(4 * compact.maxOutputTokens, 16384));
            while (keep > 0) {
              const tail = history.slice(starts[starts.length - keep]!);
              const candidate: ModelMessage[] = [
                ...(this.originalTask === undefined ? [] : [{ role: "user" as const, content: this.originalTask }]),
                { role: "user", content: `[Conversation summary]\n${summaryPlaceholder}` }, ...tail,
              ];
              if (Math.ceil(estimateRequestTokens(this.options.system, candidate, this.schemaView) * this.tokenCalibration) <= inputBudget) break;
              keep--;
            }
            try { compactResult = await this.compactWork(this.options.provider, keep, compact.maxOutputTokens,
              controller, (raw) => emit({ type: "usage", raw })); }
            catch (error) { return finish({ status: "error", steps, code: "compact_error", message: (error as Error).message }); }
            autoCompacted = compactResult.status !== "noop";
            emit({ type: "compact_end", result: compactResult });
            if (controller.signal.aborted || compactResult.status === "cancelled") return finish(interrupted());
            requestEstimate = estimate();
          }
          if (requestEstimate > inputBudget) return finish({ status: "error", steps, code: "context_budget_exceeded",
            message: `estimated input ${requestEstimate} exceeds budget ${inputBudget}` });
        }
        steps++;
        const usageEntry: UsageRecord = { method: this.options.provider.modelConfig.method, provider: this.options.provider.modelConfig.provider, raw: undefined };
        this.usageEntries.push(usageEntry);
        this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner,
          { rawUsage: this.rawUsage, usageEntries: this.usageEntries }));
        let usageIndex: number | undefined;
        const recordUsage = (raw: unknown) => {
          if (controller.signal.aborted) return;
          usageEntry.raw = structuredClone(raw);
          if (baseEstimate > 0) {
            const actual = normalizeUsage(this.options.provider.modelConfig.method, raw, this.options.provider.modelConfig.provider).inputTokensTotal;
            if (actual !== undefined) this.tokenCalibration = Math.max(this.tokenCalibration, actual / baseEstimate * 1.1);
          }
          if (usageIndex === undefined) usageIndex = this.rawUsage.push(structuredClone(raw)) - 1;
          else this.rawUsage[usageIndex] = structuredClone(raw);
          this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner,
            { rawUsage: this.rawUsage, usageEntries: this.usageEntries, tokenCalibration: this.tokenCalibration }));
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
            ...(compact?.triggerTokens !== undefined ? { maxOutputTokens: this.options.provider.modelConfig.request?.maxOutputTokens
              ?? this.options.provider.modelConfig.maxOutputTokens ?? 1024 } : {}),
            signal: controller.signal,
            onTextDelta: (text) => { if (!controller.signal.aborted) emit({ type: "text_delta", text }); },
            onReasoningDelta: (text) => { if (!controller.signal.aborted) emit({ type: "reasoning_delta", text }); },
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
          this.commitMessage(structuredClone({ role: "assistant", text: turn.text, toolCalls: [],
            ...(turn.opaque !== undefined ? { opaque: turn.opaque } : {}) }), {}, visibleMessage(turn.text));
          return finish({ status: "completed", steps, text: turn.text });
        }
        if (steps >= this.options.maxSteps) return finish({ status: "max_steps", steps, code: "max_steps", message: "tool calls require another inference step" });
        this.commitMessage(structuredClone({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls,
          ...(turn.opaque !== undefined ? { opaque: turn.opaque } : {}) }), {}, [
          ...visibleMessage(turn.text),
          ...(this.persistence?.surface === "acp" ? turn.toolCalls.map((call) => ({
            kind: "tool_call", payload: { update: acpUpdate({ type: "tool_call", id: call.id, name: call.name,
              arguments: call.arguments }) }, status: "complete",
          })) : []),
        ]);
        for (const call of turn.toolCalls) emit({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
        for (let index = 0; index < turn.toolCalls.length; index++) {
          const call = turn.toolCalls[index]!;
          if (controller.signal.aborted) {
            for (const remaining of turn.toolCalls.slice(index)) appendResult(remaining, cancelled(remaining));
            return finish(interrupted());
          }
          const dispatched = call.argumentError
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
          const result = this.options.provider.modelConfig.vision !== true && dispatched.content.some((block) => block.type === "image")
            ? capResult(errorResult("vision_disabled", "this model cannot receive image content; use a text-description tool"), this.options.maxOutputBytes)
            : dispatched;
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
      if (this.persistenceError) return finish(interrupted());
      if (controller.signal.aborted) return finish(interrupted());
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "provider_error";
      return finish({ status: "error", steps, code, message: (error as Error).message });
    }
  }
}

export function createAgent(options: AgentOptions): AgentSession { return new AgentSession(options); }
