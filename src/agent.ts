import { DEFAULT_SYSTEM_PROMPT } from "./llm/prompt.js";
import { randomUUID } from "node:crypto";
import { estimateRequestTokens, performCompaction, type CompactOptions, type CompactResult } from "./compact.js";
import { normalizeUsage, summarizeUsage, type UsageRecord, type UsageSummary } from "./llm/cache.js";
import { effectiveInputBudget } from "./llm/context.js";
import { projectReplayMessages, projectVisionMessages } from "./llm/replay.js";
import { nativeUserContent } from "./llm/content.js";
import type { CompactSettings } from "./config.js";
import { renderUserInput, type ModelMessage, type ModelToolCall, type ProviderAdapter, type UserInput } from "./llm/types.js";
import { ToolRegistry, type ToolDefinition } from "./tools/registry.js";
import { capResult, errorResult } from "./tools/results.js";
import type { ToolContext } from "./tools/primitives.js";
import { resolveAction } from "./panels/actions.js";
import { PanelHost, type PanelCall } from "./panels/host.js";
import { truncateBytes } from "./panels/render.js";
import type { PanelDocument, PanelWrites } from "./panels/contract.js";
import type { ToolResult } from "./tools/types.js";
import type { SessionOwner, SessionStore } from "./sessions/store.js";
import type { SkillVisibility } from "./sessions/store.js";
import type { SelectedSkill } from "./skills/contract.js";
import { validateStoredAgentState } from "./sessions/restore.js";
import { historyPresentation, type HistorySurface } from "./sessions/presentation.js";
import type { AgentMetadata, VisibleRecord } from "./sessions/store.js";
import type { HookDispatcher, HookReceipt } from "./hooks/dispatcher.js";
import type { HookEventName } from "./hooks/contract.js";
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

export type RunEvent = (
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown>; display?: VisibleToolCall }
  | { type: "tool_result"; id: string; name: string; result: ToolResult; display?: VisibleToolResult }
  | { type: "usage"; raw: unknown }
  | { type: "compact_start"; estimatedTokens: number; details?: CompactionDetails }
  | { type: "compact_end"; result: CompactResult; details?: CompactionDetails }
  | { type: "compact_error"; details: CompactionDetails }
  | { type: "run_end"; result: RunResult }
  | { type: "panel_update"; panel: string; owner: string; revision: number; document: PanelDocument; closed: boolean; live: boolean }
  | { type: "hook_event"; id: string; event: HookReceipt["event"]; outcome: HookReceipt["outcome"];
      durationMs: number; message?: string; code?: string }
) & { turnId?: string; segmentId?: string };

export interface CompactionDetails {
  id: string;
  cause: "manual" | "automatic";
  status: "running" | CompactResult["status"] | "error";
  keepRecentTurns: number;
  beforeTokens: number;
  afterTokens?: number;
  beforeBytes?: number;
  afterBytes?: number;
  summary?: string;
  message?: string;
}

export interface AgentOptions {
  provider: ProviderAdapter;
  registry?: ToolRegistry;
  toolSourceDigest?: string;
  selectedSkills?: readonly SelectedSkill[];
  hooks?: HookDispatcher;
  cwd?: string;
  configPath?: string;
  baseToolSelection?: readonly string[];
  explicitToolView?: boolean;
  system?: string;
  maxSteps?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  autoApprove?: boolean;
  approve?: ToolContext["approve"];
  whitelist?: readonly string[];
  compact?: Readonly<CompactSettings>;
  persistence?: { store: SessionStore; sessionId: string; surface: HistorySurface; owner?: SessionOwner; ownership?: "agent" | "host"; operationId?: string };
}

export class AgentSession {
  private readonly options: Required<Pick<AgentOptions, "provider" | "registry" | "cwd" | "system" | "maxSteps" | "maxOutputBytes" | "requestTimeoutMs" | "autoApprove">> & Pick<AgentOptions, "approve" | "whitelist" | "compact" | "hooks">;
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
  private replayBefore = 0;
  private readonly selectedSkills: readonly SelectedSkill[];
  private skillVisibility: SkillVisibility = { listed: false, loaded: [] };
  private tokenCalibration = 1;
  private persistence: { store: SessionStore; sessionId: string; owner: SessionOwner; surface: HistorySurface; ownership: "agent" | "host"; operationId?: string } | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private persistenceFailed = false;
  private persistenceError: Error | undefined;
  private currentTurnId: string | undefined;
  private segmentCounter = 0;
  private hookStarted = false;
  private readonly panels: PanelHost;

  constructor(options: AgentOptions) {
    this.selectedSkills = Object.freeze((options.selectedSkills ?? []).map((skill) => Object.freeze({ ...skill })));
    const maxSteps = options.maxSteps ?? 10000;
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
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.whitelist !== undefined ? { whitelist: [...options.whitelist] } : {}),
      ...(options.compact !== undefined ? { compact: { ...options.compact } } : {}),
    };
    this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
    if (options.persistence) {
      const { store, sessionId, surface } = options.persistence;
      if (options.persistence.ownership === "host" && !options.persistence.owner) throw new Error("host ownership requires a claimed session owner");
      const owner = options.persistence.owner ?? store.claimSession(sessionId);
      try {
        if (options.whitelist === undefined && surface === "cli") {
          const savedView = store.getStoredToolView(sessionId);
          if (savedView?.selection) {
            const known = new Set(this.options.registry.definitions().map((item) => item.name));
            this.options.whitelist = savedView.selection.filter((name) => known.has(name));
            this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
          }
        }
        const saved = store.initializeAgent(sessionId, owner, {
          cwd: this.options.cwd, system: this.options.system, modelConfig: this.options.provider.modelConfig,
          toolDefinitions: this.schemaView, selectedTools: this.options.whitelist ?? null, cacheKey: this.cacheKey,
          ...(options.configPath ? { configPath: options.configPath } : {}),
          ...(options.baseToolSelection ? { baseToolSelection: options.baseToolSelection } : {}),
          selectionExplicit: options.explicitToolView ?? false,
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
        this.replayBefore = saved.replayBefore;
        this.skillVisibility = saved.skillVisibility;
        this.persistence = { store, sessionId, owner, surface, ownership: options.persistence.ownership ?? "agent",
          ...(options.persistence.operationId ? { operationId: options.persistence.operationId } : {}) };
        if (this.persistence.ownership === "agent") this.heartbeat = setInterval(() => {
          try { store.renewSession(sessionId, owner); }
          catch (error) {
            this.persistenceFailed = true;
            this.persistenceError = error instanceof Error ? error : new Error(String(error));
            this.controller?.abort();
          }
        }, 5_000);
        this.heartbeat?.unref();
      } catch (error) {
        if (options.persistence.ownership !== "host") store.releaseSession(sessionId, owner);
        throw error;
      }
    }
    this.panels = new PanelHost({ initial: this.persistence ? this.persistence.store.listSessionPanels(this.persistence.sessionId) : [] });
  }

  get state(): AgentState { return this.currentState; }
  get transcript(): readonly ModelMessage[] { return structuredClone(this.messages); }
  get usageRecords(): readonly unknown[] { return structuredClone(this.rawUsage); }
  get cwd(): string { return this.options.cwd; }
  get contextRevision(): number { return this.contextGenerationRevision; }
  get toolDefinitions(): readonly ToolDefinition[] { return structuredClone(this.schemaView); }
  toolIdentity(name: string): string | undefined { return this.options.registry.canonicalIdentity(name); }
  get requestTimeoutMs(): number { return this.options.requestTimeoutMs; }
  stats(fromRequest = 0): UsageSummary { return summarizeUsage(this.usageEntries.slice(fromRequest)); }
  estimatedContextTokens(): number {
    return Math.ceil(estimateRequestTokens(this.options.system, this.sendMessages(), this.schemaView) * this.tokenCalibration);
  }

  private requestMessages(): ModelMessage[] { return projectReplayMessages(this.messages, this.replayBefore); }
  /** What the provider actually receives: replay projection plus text placeholders for images on non-vision models. */
  private sendMessages(messages: readonly ModelMessage[] = this.requestMessages()): ModelMessage[] {
    return projectVisionMessages(messages, this.options.provider.modelConfig.vision === true);
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

  private visiblePayload(payload: Record<string, unknown>): Record<string, unknown> {
    return { ...payload, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      ...(this.persistence?.operationId ? { operationId: this.persistence.operationId } : {}) };
  }

  private commitMessage(message: ModelMessage, metadata: AgentMetadata = {}, display: readonly VisibleRecord[] = [], consumeOperation = false,
    panels?: PanelWrites, consumeNotes?: readonly number[]): void {
    this.durable((store, sessionId, owner) => store.appendAgentMessage(sessionId, owner, message, metadata,
      display.map((item) => ({ ...item, payload: this.visiblePayload(item.payload) })),
      consumeOperation ? this.persistence?.operationId : undefined, panels, consumeNotes));
    this.messages.push(structuredClone(message));
  }

  private recordVisible(kind: string, payload: Record<string, unknown>, status = "complete"): void {
    this.durable((store, sessionId, owner) => store.appendOwnedHistory(sessionId, owner, kind, this.visiblePayload(payload), status));
  }

  private hookReceipt(receipt: HookReceipt, onEvent?: (event: RunEvent) => void): void {
    this.recordVisible("hook_event", { ...receipt }, receipt.outcome === "error" ? "error" : "complete");
    onEvent?.({ type: "hook_event", ...receipt, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) });
  }

  async start(source: "create" | "resume", onEvent?: (event: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.hookStarted) return;
    this.hookStarted = true;
    await this.options.hooks?.run("SessionStart", { cwd: this.options.cwd,
      agent_id: this.options.provider.modelConfig.agentName,
      ...(this.persistence ? { session_id: this.persistence.sessionId } : {}), source },
    { ...(signal ? { signal } : {}), deadline: Date.now() + 2000,
      onReceipt: (receipt) => this.hookReceipt(receipt, onEvent) });
  }

  setToolView(whitelist?: readonly string[]): number {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    const known = new Set(this.options.registry.definitions().map((item) => item.name));
    for (const name of whitelist ?? []) if (!known.has(name)) throw new Error(`unknown tool: ${name}`);
    const next = this.options.registry.definitions(whitelist);
    if (JSON.stringify(this.options.whitelist ?? null) === JSON.stringify(whitelist ?? null)
      && JSON.stringify(this.schemaView) === JSON.stringify(next)) return this.contextGenerationRevision;
    const nextKey = randomUUID();
    const replayBefore = this.messages.length;
    if (this.persistence) this.persistence.store.updateAgentToolView(this.persistence.sessionId, this.persistence.owner,
      whitelist ?? null, next, this.contextGenerationRevision + 1, nextKey, this.persistence.surface === "acp", replayBefore);
    if (whitelist === undefined) delete this.options.whitelist;
    else this.options.whitelist = [...whitelist];
    this.schemaView = Object.freeze(next);
    this.cacheKey = nextKey;
    this.replayBefore = replayBefore;
    return ++this.contextGenerationRevision;
  }

  clear(): void {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    if (this.persistence) this.persistence.store.clearAgentContext(this.persistence.sessionId, this.persistence.owner);
    this.messages = [];
    this.replayBefore = 0;
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
    controller: AbortController, details: CompactionDetails, onUsage?: (raw: unknown) => void): Promise<CompactResult> {
    const beforeBytes = Buffer.byteLength(JSON.stringify(this.messages), "utf8");
    const snapshot = { messages: structuredClone(this.requestMessages()), ...(this.originalTask !== undefined ? { originalTask: this.originalTask } : {}),
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
        const committedDetails: CompactionDetails = { ...details, status: "compacted", summary: work.summary, beforeBytes, afterBytes: finalBytes,
          afterTokens: Math.ceil(estimateRequestTokens(this.options.system, this.sendMessages(replacement), this.schemaView) * this.tokenCalibration) };
        this.durable((store, sessionId, owner) => store.replaceAgentContext(sessionId, owner, replacement,
          { summaryText: work.summary!, rawUsage: this.rawUsage, usageEntries: this.usageEntries,
            tokenCalibration: this.tokenCalibration, replayBefore: 0, ...(notice ? { skillNotice: notice } : {}) },
          false, [{ kind: "compaction", payload: this.visiblePayload({ ...committedDetails }) }]));
        Object.assign(details, committedDetails);
        this.messages = structuredClone(replacement);
        this.replayBefore = 0;
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

  private async compactAttempt(provider: ProviderAdapter, keepRecentTurns: number, maxOutputTokens: number,
    controller: AbortController, cause: CompactionDetails["cause"], onEvent?: (event: RunEvent) => void): Promise<CompactResult> {
    const details: CompactionDetails = { id: randomUUID(), cause, status: "running", keepRecentTurns,
      beforeTokens: this.estimatedContextTokens(), beforeBytes: Buffer.byteLength(JSON.stringify(this.messages)) };
    const emit = (event: RunEvent) => onEvent?.(structuredClone({ ...event,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) }));
    this.recordVisible("compaction", { ...details });
    try {
      emit({ type: "compact_start", estimatedTokens: details.beforeTokens, details });
      const result = await this.compactWork(provider, keepRecentTurns, maxOutputTokens, controller, details,
        (raw) => emit({ type: "usage", raw }));
      Object.assign(details, { status: result.status, afterTokens: this.estimatedContextTokens(),
        beforeBytes: result.beforeBytes ?? details.beforeBytes, afterBytes: result.status === "compacted" ? result.afterBytes : details.beforeBytes });
      if (result.status !== "compacted") this.recordVisible("compaction", { ...details });
      emit({ type: "compact_end", result, details });
      return result;
    } catch (error) {
      // A failure to deliver an already committed success cannot relabel its context as rolled back.
      if (details.status !== "compacted") {
        Object.assign(details, { status: "error", message: error instanceof Error ? error.message : String(error),
          afterTokens: this.estimatedContextTokens() });
        try { this.recordVisible("compaction", { ...details }, "error"); } catch { /* preserve an unavailable store failure */ }
        try { emit({ type: "compact_error", details }); } catch { /* preserve the original failure */ }
      }
      throw error;
    }
  }

  async close(onEvent?: (event: RunEvent) => void): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closing";
    this.controller?.abort();
    try {
      if (this.activeRun) await this.activeRun;
      if (this.activeCompact) await this.activeCompact;
      if (this.hookStarted) await this.options.hooks?.run("SessionEnd", { cwd: this.options.cwd,
        agent_id: this.options.provider.modelConfig.agentName,
        ...(this.persistence ? { session_id: this.persistence.sessionId } : {}) },
      { deadline: Date.now() + 2000, onReceipt: (receipt) => this.hookReceipt(receipt, onEvent) });
    }
    finally {
      this.panels.close();
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.persistence?.ownership === "agent") this.persistence.store.releaseSession(this.persistence.sessionId, this.persistence.owner);
      this.currentState = "closed";
    }
  }

  compact(options: CompactOptions = {}, onEvent?: (event: RunEvent) => void): Promise<CompactResult> {
    if (this.currentState === "closed" || this.currentState === "closing") return Promise.reject(new Error("agent session is closed"));
    if (this.currentState !== "idle") return Promise.reject(new Error("agent session is busy"));
    if (this.persistenceFailed) return Promise.reject(new Error("session persistence failed; close and resume to recover"));
    this.currentTurnId = undefined;
    const keepRecentTurns = options.keepRecentTurns ?? 2;
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      return Promise.reject(new Error("invalid compaction settings"));
    }
    this.currentState = "compacting";
    this.heartbeat?.ref();
    const controller = new AbortController();
    this.controller = controller;
    const task = this.compactAttempt(options.provider ?? this.options.provider, keepRecentTurns, maxOutputTokens, controller, "manual", onEvent).finally(() => {
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
    this.currentTurnId = this.persistence?.operationId ?? randomUUID();
    this.segmentCounter = 0;
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

  /**
   * Runs one declared `tool` panel action for the user (docs/panels-design.md §11) through the unchanged dispatch path:
   * the click consents to an `allow` rule only, `ask` still asks, `deny` never runs, and hooks see `source: "user_action"`.
   * Updates, the receipt and a note for the model's next request commit in one transaction; nothing is committed when the
   * handler never ran.
   */
  runPanelAction(request: { panel: string; action: string; block?: string; item?: string }, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    if (this.currentState === "closed" || this.currentState === "closing") return Promise.reject(new Error("agent session is closed"));
    if (this.currentState !== "idle") return Promise.reject(new Error("agent session is busy"));
    if (this.persistenceFailed) return Promise.reject(new Error("session persistence failed; close and resume to recover"));
    this.currentState = "running";
    this.currentTurnId = this.persistence?.operationId ?? randomUUID();
    this.heartbeat?.ref();
    const controller = new AbortController();
    this.controller = controller;
    const running = this.panelAction(request, controller, onEvent).finally(() => {
      this.controller = undefined;
      this.activeRun = undefined;
      this.panels.setListener(undefined);
      this.heartbeat?.unref();
      if (this.currentState !== "closing" && this.currentState !== "closed") this.currentState = "idle";
    });
    this.activeRun = running;
    return running;
  }

  private async panelAction(request: { panel: string; action: string; block?: string; item?: string }, controller: AbortController,
    onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    const fail = (code: string, message: string): RunResult => ({ status: "error", steps: 0, code, message });
    const emit = (event: RunEvent) => { try { onEvent?.(structuredClone({ ...event, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) })); } catch { /* observers never own execution */ } };
    const hash = request.panel.lastIndexOf("#");
    const owner = hash < 0 ? "" : request.panel.slice(0, hash);
    const registry = this.options.registry;
    const toolName = registry.nameForIdentity(owner);
    const info = toolName ? registry.panelDeclarations(toolName) : undefined;
    const declaration = info?.declarations.find((item) => item.id === request.panel.slice(hash + 1));
    if (!toolName || !info || !declaration) return fail("stale_panel", "the tool that owns this panel is not selected by this agent");
    const stored = this.panels.snapshot().find((panel) => panel.panelId === request.panel);
    let resolved;
    try { resolved = resolveAction(declaration, request, stored?.document ?? null); }
    catch (error) { return fail("invalid_action", (error as Error).message); }
    if (resolved.action.kind !== "tool") return fail("invalid_action", "only tool actions run on the host");
    const operationId = this.currentTurnId!;
    const hookRequest = () => ({ cwd: this.options.cwd, agent_id: this.options.provider.modelConfig.agentName,
      ...(this.persistence ? { session_id: this.persistence.sessionId } : {}), turn_id: operationId });
    this.panels.setListener((event) => emit({ type: "panel_update", ...event }));
    const panelCall = this.panels.begin(operationId, info, "user_action");
    let started = false;
    let dispatched: ToolResult;
    try {
      await this.start(this.messages.length ? "resume" : "create", emit, controller.signal);
      dispatched = await registry.dispatch(toolName, resolved.arguments ?? {}, {
        cwd: this.options.cwd,
        maxOutputBytes: this.options.maxOutputBytes,
        autoApprove: true,
        ...(this.options.approve ? { approve: this.options.approve } : {}),
        ...(this.options.whitelist !== undefined ? { whitelist: this.options.whitelist } : {}),
        signal: controller.signal,
        toolCallId: operationId,
        panels: panelCall.context, onPanelUpdates: (updates) => panelCall.collect(updates), onHandlerSettled: () => panelCall.endWindow(),
        ...(this.options.hooks ? { onHook: (event: HookEventName, identity: string, name: string, args: Record<string, unknown>, result?: ToolResult) =>
          this.options.hooks!.run(event, { ...hookRequest(), tool: { identity, name, source: "user_action", arguments: args, ...(result ? { result } : {}) } },
            { ...(event === "PreToolUse" ? { signal: controller.signal } : { deadline: Date.now() + 2000 }),
              onReceipt: (receipt) => this.hookReceipt(receipt, emit) }) } : {}),
        onStart: () => { started = true; },
      });
    } catch (error) {
      panelCall.rollback();
      return controller.signal.aborted ? { status: "cancelled", steps: 0 } : fail("action_error", (error as Error).message);
    }
    if (!started) { panelCall.rollback(); if (controller.signal.aborted) return { status: "cancelled", steps: 0 }; return fail(dispatched.code ?? "action_error", dispatched.content.find((block) => block.type === "text")?.text ?? "the action did not run"); }
    try {
      const settled = panelCall.settle(dispatched.content.length === 0);
      const text = truncateBytes([...dispatched.content.flatMap((block) => block.type === "text" ? [block.text] : []), ...settled.lines].join("\n"), 1024);
      // The receipt for the panel the user clicked: the update the tool made to it, or its unchanged current state.
      const local = request.panel.slice(hash + 1);
      const own = settled.receipts.find((receipt) => receipt.panel === local && receipt.owner === owner) ?? panelCall.unchangedReceipt(local);
      const receipts = settled.receipts.includes(own) ? settled.receipts : [...settled.receipts, own];
      const title = own.title;
      const note = `The user ran "${resolved.action.label}" on ${title}; ${owner} returned: ${text || (dispatched.isError ? "an error" : "no text")}`;
      this.durable((store, sessionId, sessionOwner) => store.commitPanelAction(sessionId, sessionOwner, {
        ...(settled.writes ? { panels: settled.writes } : {}), note,
        display: receipts.map((receipt) => ({ kind: "panel_receipt", payload: this.visiblePayload({ ...receipt }) })) }));
      panelCall.commit();
    } catch (error) {
      panelCall.rollback();
      return this.persistenceError ? fail("persistence_error", this.persistenceError.message) : fail("action_error", (error as Error).message);
    }
    if (controller.signal.aborted) return { status: "cancelled", steps: 0 };
    return dispatched.isError
      ? fail(dispatched.code ?? "action_error", dispatched.content.find((block) => block.type === "text")?.text ?? "the action failed")
      : { status: "completed", steps: 0, text: "" };
  }

  private async execute(input: UserInput, controller: AbortController, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    let steps = 0;
    let observerError: Error | undefined;
    let ended = false;
    let terminalDeadline: number | undefined;
    const presentation = historyPresentation(this.persistence?.surface);
    const visibleSegments: Array<{ kind: "assistant" | "reasoning"; text: string; segmentId: string }> = [];
    const appendVisible = (kind: "assistant" | "reasoning", text: string) => {
      if (!text) return;
      const last = visibleSegments.at(-1);
      if (last?.kind === kind) last.text += text;
      else visibleSegments.push({ kind, text, segmentId: `${this.currentTurnId}:segment:${++this.segmentCounter}` });
      return visibleSegments.at(-1)!.segmentId;
    };
    const startedCalls = new Set<string>();
    const startedAt = new Map<string, number>();
    const emit = (event: RunEvent) => {
      if (observerError) return;
      try {
        let segmentId: string | undefined;
        if (event.type === "text_delta") segmentId = appendVisible("assistant", event.text);
        else if (event.type === "reasoning_delta") segmentId = appendVisible("reasoning", event.text);
        else if (event.type === "tool_start") {
          for (const item of presentation.start(event.id, event.name, this.toolIdentity(event.name), event.arguments))
            this.recordVisible(item.kind, item.payload, item.status);
          startedCalls.add(event.id);
          startedAt.set(event.id, performance.now());
        }
        onEvent?.(structuredClone({ ...event, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          ...(segmentId ? { segmentId } : {}) }));
      }
      catch (error) {
        observerError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    };
    const visibleMessage = (fallbackText = "", status = "complete"): VisibleRecord[] => {
      const segments = visibleSegments.splice(0);
      if (fallbackText && !segments.some((segment) => segment.kind === "assistant")) {
        segments.push({ kind: "assistant", text: fallbackText, segmentId: `${this.currentTurnId}:segment:${++this.segmentCounter}` });
      }
      return presentation.messages(segments, status);
    };
    this.panels.setListener((event) => emit({ type: "panel_update", ...event }));
    const hookRequest = () => ({ cwd: this.options.cwd, agent_id: this.options.provider.modelConfig.agentName,
      ...(this.persistence ? { session_id: this.persistence.sessionId } : {}),
      ...(this.currentTurnId ? { turn_id: this.currentTurnId } : {}) });
    const finish = async (result: RunResult): Promise<RunResult> => {
      if (!ended) {
        ended = true;
        this.panels.setListener(undefined);
        let finalResult = result;
        try {
          await this.options.hooks?.run("Stop", { ...hookRequest(), run: result },
            { deadline: terminalDeadline ?? Date.now() + 2000,
              onReceipt: (receipt) => this.hookReceipt(receipt, emit) });
        } catch (error) {
          finalResult = { status: "error", steps, code: "hook_event_error", message: String(error) };
        }
        const status = result.status === "cancelled" ? "interrupted" : result.status === "error" ? "error" : "complete";
        if (!this.persistenceError) {
          try { for (const item of visibleMessage("", status)) this.recordVisible(item.kind, item.payload, item.status); }
          catch (error) {
            finalResult = { status: "error", steps, code: "persistence_error",
              message: error instanceof Error ? error.message : String(error) };
          }
        }
        if (this.persistence?.surface === "web" && !this.persistenceError) {
          try { this.recordVisible("run_end", { result: finalResult }); }
          catch (error) { finalResult = { status: "error", steps, code: "persistence_error", message: String(error) }; }
        }
        try { onEvent?.(structuredClone({ type: "run_end", result: finalResult, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) })); }
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
    const appendResult = (call: ModelToolCall, dispatchedResult: ToolResult, panelCall?: PanelCall) => {
      let result = dispatchedResult;
      let panelWrites: PanelWrites | undefined;
      let panelRecords: VisibleRecord[] = [];
      if (panelCall) {
        // Ends the handler's panel window, applies result-block updates and prepares the atomic commit (panels-design §8.0, §10).
        const settled = panelCall.settle(result.content.length === 0);
        if (settled.lines.length) result = { ...result, content: [...result.content, { type: "text", text: settled.lines.join("\n") }] };
        panelWrites = settled.writes;
        panelRecords = settled.receipts.map((receipt) => ({ kind: "panel_receipt", payload: { ...receipt } }));
      }
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
      const identity = this.toolIdentity(call.name);
      const projected = { ...projectToolResult(call.name, identity, publicResult,
        startedAt.has(call.id) ? performance.now() - startedAt.get(call.id)! : undefined), id: call.id };
      const display = presentation.result({ type: "tool_result", id: call.id, name: call.name, result: publicResult },
        identity, call.arguments, startedCalls.has(call.id), projected);
      try {
        this.commitMessage({ role: "tool", callId: call.id, name: call.name, result: structuredClone(result) },
          visibility ? { skillVisibility: visibility } : {}, [...display, ...panelRecords], false, panelWrites);
        panelCall?.commit();
      } catch (error) { panelCall?.rollback(); throw error; }
      if (visibility) this.skillVisibility = visibility;
      emit({ type: "tool_result", id: call.id, name: call.name, result: publicResult, display: projected });
    };
    const firstTask = this.originalTask === undefined;
    let autoCompacted = false;
    try {
      await this.start(this.messages.length ? "resume" : "create", emit, controller.signal);
      try { nativeUserContent(input); }
      catch (error) { return finish({ status: "error", steps, code: "unsupported_content", message: (error as Error).message }); }
      const promptHook = await this.options.hooks?.run("UserPromptSubmit", { ...hookRequest(), input },
        { signal: controller.signal, onReceipt: (receipt) => this.hookReceipt(receipt, emit) });
      if (controller.signal.aborted) return finish(interrupted());
      if (promptHook?.blocked) return finish({ status: "error", steps,
        code: promptHook.blocked === "denied" ? "hook_denied" : "hook_error",
        ...(promptHook.reason ? { message: promptHook.reason } : {}) });
      // Notes about panel actions the user ran since the last turn travel with this message and are cleared with it (§10).
      const notes = this.persistence ? this.persistence.store.pendingNotes(this.persistence.sessionId) : [];
      const noteText = notes.map((note) => note.text).join("\n");
      const modelInput: UserInput = !notes.length ? input
        : typeof input === "string" ? `${noteText}\n\n${input}` : [{ type: "text", text: noteText }, ...input];
      this.commitMessage({ role: "user", content: structuredClone(modelInput) }, firstTask ? { originalTask: input } : {},
        [{ kind: "user", payload: { input: structuredClone(input) } }], true, undefined, notes.map((note) => note.sequence));
      if (firstTask) this.originalTask = structuredClone(input);
      // A chat still carrying a placeholder title is named from its first message, even when that turn predates this fix.
      this.durable((store, sessionId, owner) => store.setTitleFromPrompt(sessionId, owner, renderUserInput(input)));
      while (steps < this.options.maxSteps) {
        if (controller.signal.aborted) return finish(interrupted());
        let requestEstimate = 0;
        let baseEstimate = 0;
        const compact = this.options.compact;
        if (compact?.triggerTokens !== undefined) {
          const modelConfig = this.options.provider.modelConfig;
          const context = modelConfig.contextWindow!;
          const outputReserve = modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens ?? 1024;
          const inputBudget = effectiveInputBudget(context, outputReserve);
          const estimate = () => {
            baseEstimate = estimateRequestTokens(this.options.system, this.sendMessages(), this.schemaView);
            return Math.ceil(baseEstimate * this.tokenCalibration);
          };
          requestEstimate = estimate();
          if (requestEstimate >= compact.triggerTokens && !autoCompacted) {
            if (controller.signal.aborted) return finish(interrupted());
            let compactResult: CompactResult;
            const effective = this.requestMessages();
            const history = this.summaryText ? effective.slice(1) : effective;
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
              if (Math.ceil(estimateRequestTokens(this.options.system, this.sendMessages(candidate), this.schemaView) * this.tokenCalibration) <= inputBudget) break;
              keep--;
            }
            try { compactResult = await this.compactAttempt(this.options.provider, keep, compact.maxOutputTokens,
              controller, "automatic", emit); }
            catch (error) { return finish({ status: "error", steps, code: "compact_error", message: (error as Error).message }); }
            autoCompacted = compactResult.status !== "noop";
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
            messages: this.sendMessages(),
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
          ...turn.toolCalls.flatMap((call) => presentation.declaration(call.id, call.name, call.arguments)),
        ]);
        for (const call of turn.toolCalls) emit({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
        for (let index = 0; index < turn.toolCalls.length; index++) {
          const call = turn.toolCalls[index]!;
          if (controller.signal.aborted) {
            for (const remaining of turn.toolCalls.slice(index)) appendResult(remaining, cancelled(remaining));
            return finish(interrupted());
          }
          const panelInfo = call.argumentError ? undefined : this.options.registry.panelDeclarations(call.name);
          const panelCall = panelInfo ? this.panels.begin(call.id, panelInfo) : undefined;
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
              ...(panelCall ? { panels: panelCall.context, onPanelUpdates: (updates) => panelCall.collect(updates), onHandlerSettled: () => panelCall.endWindow() } : {}),
              ...(this.options.hooks ? { onHook: (event: HookEventName, identity: string,
                name: string, args: Record<string, unknown>, result?: ToolResult) => this.options.hooks!.run(event,
                { ...hookRequest(), tool: { identity, name, source: "model", arguments: args, ...(result ? { result } : {}) } },
                { ...(event === "PreToolUse" ? { signal: controller.signal } : {
                  deadline: controller.signal.aborted ? (terminalDeadline ??= Date.now() + 2000) : Date.now() + 2000 }),
                  onReceipt: (receipt) => this.hookReceipt(receipt, emit) }) } : {}),
              onStart: (name, args) => emit({ type: "tool_start", id: call.id, name, arguments: args }),
            });
          const result = this.options.provider.modelConfig.vision !== true && dispatched.content.some((block) => block.type === "image")
            ? capResult(errorResult("vision_disabled", "this model cannot receive image content; use a text-description tool"), this.options.maxOutputBytes)
            : dispatched;
          appendResult(call, result, panelCall);
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
