import type { ProcessSupervisor } from "./processes/supervisor.js";
import { InteractionError, type InteractionContext, type InteractionAdapter } from "./interactions/contract.js";
import { InteractionService } from "./interactions/service.js";
import { DEFAULT_SYSTEM_PROMPT } from "./llm/prompt.js";
import { createHash, randomUUID } from "node:crypto";
import { anchoredEstimate, parseAnchor, type ContextAnchor } from "./context-anchor.js";
import { buildCheckpointMessage, CHECKPOINT_MARKER, checkpointWords, collectFacts, cutNames, cutText, cutToolResult, cutUserInput, defaultCompactOutputTokens, emptyFacts,
  estimateRequestTokens, isCheckpointMessage, isReasoningRejection, LEDGER_CAP_TOKENS, ledgerPointer, ledgerText, LEGACY_LEDGER_NOTE,
  LEGACY_NOTE_SOURCE, mechanicalCheckpoint, MIN_CHECKPOINT_OUTPUT_TOKENS, renderLedger, renderWorkingState, resultText, SUMMARY_CUT_NOTICE, SUMMARY_MESSAGE_PREFIX,
  summarizeTranscript, textTokens, transcriptSteps, userTextBytes, WORKING_STATE_BYTES, writtenCheckpoint, type CompactionLedgerState, type CompactOptions, type CompactResult,
  type LedgerEntry, type RenderOptions } from "./compact.js";
import { existsSync } from "node:fs";
import { CLEAR_MIN_FREED_TOKENS, CLEAR_TARGET_RATIO, clearToolResults, namedByReminder } from "./context-clearing.js";
import { normalizeUsage, summarizeUsage, type UsageRecord, type UsageSummary } from "./llm/cache.js";
import { effectiveInputBudget } from "./llm/context.js";
import { projectImageLimits, projectReplayMessages, projectVisionMessages, requestImageLimits } from "./llm/replay.js";
import { nativeUserContent } from "./llm/content.js";
import type { CompactSettings } from "./config.js";
import { renderUserInput, type ModelMessage, type ModelToolCall, type ProviderAdapter, type UserInput } from "./llm/types.js";
import { ToolRegistry, type ToolDefinition } from "./tools/registry.js";
import { capResult, DEFAULT_MAX_OUTPUT_BYTES, errorResult } from "./tools/results.js";
import { effectiveOutputTokens } from "./llm/output.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./llm/types.js";
import type { ToolContext } from "./tools/primitives.js";
import { resolveAction } from "./panels/actions.js";
import { PanelHost, type PanelCall, type PanelLiveEvent } from "./panels/host.js";
import { isPanelReminder, panelReminders, truncateBytes } from "./panels/render.js";
import type { PanelDocument, PanelReceipt, PanelWrites, StoredPanel } from "./panels/contract.js";
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
  | { type: "tool_result"; id: string; name: string; result: ToolResult; display?: VisibleToolResult;
      /** The panel receipts committed with this result, for surfaces that print them (docs/panels-design.md §13.2). */
      panelReceipts?: PanelReceipt[] }
  | { type: "usage"; raw: unknown }
  | { type: "compact_start"; estimatedTokens: number; details?: CompactionDetails }
  | { type: "compact_end"; result: CompactResult; details?: CompactionDetails }
  | { type: "compact_error"; details: CompactionDetails }
  | { type: "run_end"; result: RunResult }
  | ({ type: "panel_update" } & PanelLiveEvent)
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

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;

/** What one compaction is asked to keep and spend. */
interface CompactWorkSettings {
  keepRecentTurns: number;
  keepRecentTokens?: number | undefined;
  maxOutputTokens: number;
  maxOutputTokensDefaulted: boolean;
  instructions?: string | undefined;
  /** A fallback compaction (§6.7): no summary request; the checkpoint is the previous one with a note giving this reason. */
  mechanical?: string | undefined;
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
  interactions?: InteractionService;
  interactionAdapter?: InteractionAdapter;
  processes?: ProcessSupervisor;
  whitelist?: readonly string[];
  compact?: Readonly<CompactSettings>;
  persistence?: { store: SessionStore; sessionId: string; surface: HistorySurface; owner?: SessionOwner; ownership?: "agent" | "host"; operationId?: string };
}

/** Total time observing hooks may still take once a run was interrupted; otherwise each hook's own timeout_ms applies. */
const HOOK_TEARDOWN_MS = 2000;

/** Consecutive cut-off answers continued before the run ends with what it has; bounds a model that never finishes. */
const MAX_OUTPUT_CONTINUATIONS = 8;
const OUTPUT_LIMIT_NOTICE = "[Raw output limit notice] Your previous response was cut off at the output token limit. Continue exactly where it stopped, without repeating what you already wrote.";

export class AgentSession {
  private readonly options: Required<Pick<AgentOptions, "provider" | "registry" | "cwd" | "system" | "maxSteps" | "maxOutputBytes" | "requestTimeoutMs" | "autoApprove">> & Pick<AgentOptions, "approve" | "whitelist" | "compact" | "hooks" | "interactions" | "processes">;
  private messages: ModelMessage[] = [];
  private currentState: AgentState = "idle";
  private controller: AbortController | undefined;
  private activeRun: Promise<RunResult> | undefined;
  private activeCompact: Promise<CompactResult> | undefined;
  private rawUsage: unknown[] = [];
  private usageEntries: UsageRecord[] = [];
  private originalTask: UserInput | undefined;
  private summaryText: string | undefined;
  /** The compaction ledger and working-state facts; absent until a checkpoint compaction commits (design §6.2). */
  private ledgerState: CompactionLedgerState | undefined;
  /** The first request after a compaction may retry once with history projected, when the provider rejects replayed reasoning. */
  private replayRetryArmed = false;
  private cacheKey: string = randomUUID();
  private schemaView: readonly ToolDefinition[];
  private contextGenerationRevision = 1;
  private replayBefore = 0;
  private readonly selectedSkills: readonly SelectedSkill[];
  private skillVisibility: SkillVisibility = { listed: false, loaded: [] };
  private tokenCalibration = 1;
  /** The provider-reported size at the last response, and the size of the response in flight until its reply is committed. */
  private anchor: ContextAnchor | undefined;
  private reported: number | undefined;
  private signatureCache: { key: string; view: readonly ToolDefinition[]; signature: string } | undefined;
  private persistence: { store: SessionStore; sessionId: string; owner: SessionOwner; surface: HistorySurface; ownership: "agent" | "host"; operationId?: string } | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private persistenceFailed = false;
  private persistenceError: Error | undefined;
  private currentTurnId: string | undefined;
  private segmentCounter = 0;
  private hookStarted = false;
  private readonly panels: PanelHost;
  private readonly processSessionId = randomUUID();
  private readonly ownedInteractions?: InteractionService;

  constructor(options: AgentOptions) {
    if (options.interactions && options.interactionAdapter) throw new Error("provide interactions or interactionAdapter, not both");
    if (options.persistence) options.processes?.assertStoreBinding(options.persistence.store);
    if (options.persistence) options.interactions?.assertStoreBinding(options.persistence.store);
    this.selectedSkills = Object.freeze((options.selectedSkills ?? []).map((skill) => Object.freeze({ ...skill })));
    const maxSteps = options.maxSteps ?? 10000;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    for (const [name, value] of [["maxSteps", maxSteps], ["maxOutputBytes", maxOutputBytes], ["requestTimeoutMs", requestTimeoutMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || (name === "requestTimeoutMs" && value > 2147483647)) throw new Error(`${name} must be a positive integer within the supported range`);
    }
    if (options.compact !== undefined && (!Number.isSafeInteger(options.compact.keepRecentTurns)
      || options.compact.keepRecentTurns < 0 || !Number.isSafeInteger(options.compact.maxOutputTokens)
      || options.compact.maxOutputTokens < 1 || (options.compact.keepRecentTokens !== undefined
        && (!Number.isSafeInteger(options.compact.keepRecentTokens) || options.compact.keepRecentTokens < 1)))) throw new Error("invalid compaction settings");
    if (options.compact?.triggerTokens !== undefined) {
      const context = options.provider.modelConfig.contextWindow;
      const output = effectiveOutputTokens(options.provider.modelConfig);
      if (!Number.isSafeInteger(context) || context! < 1 || !Number.isSafeInteger(options.compact.triggerTokens)
        || options.compact.triggerTokens < 1 || options.compact.triggerTokens >= context! - output - Math.max(64, Math.ceil(context! * 0.05))) {
        throw new Error("auto compact trigger requires a valid context window and output reserve");
      }
    }
    if (options.compact?.clearTokens !== undefined && (!Number.isSafeInteger(options.provider.modelConfig.contextWindow)
      || !Number.isSafeInteger(options.compact.clearTokens) || options.compact.clearTokens < 1)) {
      throw new Error("tool result clearing requires a valid context window and threshold");
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
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.interactions ? { interactions: options.interactions } : {}),
      ...(options.whitelist !== undefined ? { whitelist: [...options.whitelist] } : {}),
      ...(options.compact !== undefined ? { compact: { ...options.compact } } : {}),
    };
    this.schemaView = Object.freeze(this.options.registry.definitions(this.options.whitelist));
    this.options.hooks?.validateTools(this.options.registry, this.schemaView.map(tool => tool.name));
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
        this.ledgerState = saved.ledger;
        this.replayRetryArmed = saved.ledger?.retryArmed === true;
        this.rawUsage = structuredClone(saved.rawUsage);
        this.usageEntries = structuredClone(saved.usageEntries);
        this.tokenCalibration = saved.tokenCalibration;
        this.anchor = parseAnchor(saved.anchor, saved.messages.length);
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
    if (options.interactionAdapter) {
      this.ownedInteractions = new InteractionService({ adapter: options.interactionAdapter, ...(this.persistence ? { store: this.persistence.store } : {}) });
      this.options.interactions = this.ownedInteractions;
    }
    this.panels = new PanelHost({ initial: this.persistence ? this.persistence.store.listSessionPanels(this.persistence.sessionId) : [] });
  }

  get state(): AgentState { return this.currentState; }
  /** The operation/turn ID of the run in progress (the tool call ID of a panel action), if any. */
  get activeTurnId(): string | undefined { return this.currentTurnId; }
  /** The latest committed state of one panel of this session, by full ID. */
  panel(panelId: string): StoredPanel | undefined { return this.panels.snapshot().find((item) => item.panelId === panelId); }

  private panelScope(runId = this.currentTurnId ?? randomUUID()) {
    return { runId, ...(this.persistence ? { sessionId: this.persistence.sessionId,
      ...(this.persistence.operationId ? { operationId: this.persistence.operationId } : {}) } : {}) };
  }
  private interactionContext(callId: string, owner: string, panelCall: PanelCall | undefined, signal: AbortSignal): InteractionContext {
    const service = this.options.interactions;
    if (!service || !panelCall) return { request: async () => { throw new InteractionError("interaction_unavailable", "interaction_unavailable: this host has no response adapter"); } };
    return service.forCall({ identity: { ...this.panelScope(), toolCallId: callId, owner, panelId: "" },
      maxOutputBytes: this.options.maxOutputBytes, signal,
      ...(this.persistence ? { owner: this.persistence.owner } : {}),
      prepare: panel => panelCall.prepareInteraction(panel),
      publish: async (panel, document) => { await panelCall.context.update(panel, { op: "replace", document }); } });
  }
  private settleHandler(callId: string, panelCall: PanelCall | undefined): void {
    this.options.interactions?.endCall(this.panelScope().runId, callId); panelCall?.endWindow();
  }
  get transcript(): readonly ModelMessage[] { return structuredClone(this.messages); }
  get usageRecords(): readonly unknown[] { return structuredClone(this.rawUsage); }
  get cwd(): string { return this.options.cwd; }
  get contextRevision(): number { return this.contextGenerationRevision; }
  get toolDefinitions(): readonly ToolDefinition[] { return structuredClone(this.schemaView); }
  toolIdentity(name: string): string | undefined { return this.options.registry.canonicalIdentity(name); }
  get requestTimeoutMs(): number { return this.options.requestTimeoutMs; }
  stats(fromRequest = 0): UsageSummary { return summarizeUsage(this.usageEntries.slice(fromRequest)); }
  estimatedContextTokens(): number { return this.contextUsage().tokens; }
  /** The size of the conversation now: the provider's own count when one covers it, else the calibrated byte estimate. */
  contextUsage(): { tokens: number; source: "provider" | "estimate" } {
    const { tokens, exact } = this.nextRequestSize();
    return { tokens, source: exact ? "provider" : "estimate" };
  }
  /** What identifies the measurement conditions: system prompt, tool schemas, model, image projection and replay boundary. */
  private anchorSignature(): string {
    const { provider, model, method, vision } = this.options.provider.modelConfig;
    const key = JSON.stringify([this.options.system, provider, model, method, vision === true, this.replayBefore]);
    if (this.signatureCache?.view !== this.schemaView || this.signatureCache.key !== key) {
      this.signatureCache = { key, view: this.schemaView, signature: createHash("sha256")
        .update(JSON.stringify([key, this.schemaView])).digest("hex").slice(0, 24) };
    }
    return this.signatureCache.signature;
  }
  /**
   * Tokens of the request that would be sent for `messages`. With `anchored` (the live conversation) a reported size plus the
   * estimated addition is used when it applies; a candidate context, or one the anchor does not describe, is the calibrated estimate.
   */
  private nextRequestSize(messages: readonly ModelMessage[] = this.sendMessages(), anchored = true): { tokens: number; exact: boolean; base: number; measured: boolean } {
    const base = estimateRequestTokens(this.options.system, messages, this.schemaView);
    const known = anchored ? anchoredEstimate(this.anchor, this.anchorSignature(), this.messages.length, base, this.tokenCalibration) : undefined;
    return known ? { ...known, base, measured: true } : { tokens: Math.ceil(base * this.tokenCalibration), exact: false, base, measured: false };
  }
  /** The anchor for a reply about to be added: the reported size of the request it answers plus the byte estimate of request and reply. */
  private anchorFor(reply: ModelMessage): ContextAnchor | undefined {
    if (this.reported === undefined) return undefined;
    const base = estimateRequestTokens(this.options.system, this.sendMessages([...this.requestMessages(), reply]), this.schemaView);
    return { tokens: this.reported, base, messageCount: this.messages.length + 1, signature: this.anchorSignature() };
  }
  private requestMessages(): ModelMessage[] { return projectReplayMessages(this.messages, this.replayBefore); }
  /** What the provider actually receives: replay projection plus text placeholders for images the model cannot read or the API would reject. */
  private sendMessages(messages: readonly ModelMessage[] = this.requestMessages()): ModelMessage[] {
    const modelConfig = this.options.provider.modelConfig;
    return projectImageLimits(projectVisionMessages(messages, modelConfig.vision === true), requestImageLimits(modelConfig.method),
      () => Buffer.byteLength(JSON.stringify(this.options.system), "utf8") + Buffer.byteLength(JSON.stringify(this.schemaView), "utf8"));
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
    const anchor = message.role === "assistant" ? this.anchorFor(message) : undefined;
    this.durable((store, sessionId, owner) => store.appendAgentMessage(sessionId, owner, message, anchor ? { ...metadata, anchor } : metadata,
      display.map((item) => ({ ...item, payload: this.visiblePayload(item.payload) })),
      consumeOperation ? this.persistence?.operationId : undefined, panels, consumeNotes));
    this.messages.push(structuredClone(message));
    if (anchor) { this.anchor = anchor; this.reported = undefined; }
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
    { ...(signal ? { signal } : {}), onReceipt: (receipt) => this.hookReceipt(receipt, onEvent) });
  }

  setToolView(whitelist?: readonly string[]): number {
    if (this.currentState !== "idle") throw new Error(this.currentState === "closed" ? "agent session is closed" : "agent session is busy");
    const known = new Set(this.options.registry.definitions().map((item) => item.name));
    for (const name of whitelist ?? []) if (!known.has(name)) throw new Error(`unknown tool: ${name}`);
    const next = this.options.registry.definitions(whitelist);
    this.options.hooks?.validateTools(this.options.registry, next.map(tool => tool.name));
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
    this.anchor = undefined;
    this.reported = undefined;
    this.replayBefore = 0;
    this.originalTask = undefined;
    this.summaryText = undefined;
    this.ledgerState = undefined;
    this.replayRetryArmed = false;
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

  /** The user's typed input behind a context message: the message itself, or its tail after the panel-action notes. */
  private static carriesInput(content: UserInput, input: UserInput): boolean {
    if (typeof input === "string") return typeof content === "string" && (content === input || content.endsWith(`\n\n${input}`));
    return Array.isArray(content) && content.length >= input.length && JSON.stringify(content.slice(content.length - input.length)) === JSON.stringify(input);
  }

  /**
   * Plans and commits one checkpoint compaction (docs/compaction-v2-design.md §6.2, §6.2.1): the oldest steps are summarized,
   * the newest stay verbatim, and the user's messages, working state, checkpoint and resume text lead the new context.
   */
  private async compactWork(provider: ProviderAdapter, settings: CompactWorkSettings, controller: AbortController, details: CompactionDetails,
    onUsage?: (raw: unknown) => void): Promise<CompactResult> {
    const beforeBytes = Buffer.byteLength(JSON.stringify(this.messages), "utf8");
    // Roles and identities come from the stored messages; what is sent comes from their replay projection, index for index.
    const source = structuredClone(this.messages);
    const text = (message: ModelMessage | undefined) => message?.role === "user" && typeof message.content === "string" ? message.content : undefined;
    // The host prefix of the last compaction: a checkpoint message, or the old layout's pinned task and summary.
    let start = 0;
    if (this.summaryText !== undefined) {
      if (isCheckpointMessage(source[0]) || text(source[0])?.startsWith(SUMMARY_MESSAGE_PREFIX)) start = 1;
      else if (text(source[1])?.startsWith(SUMMARY_MESSAGE_PREFIX) && this.originalTask !== undefined
        && source[0]?.role === "user" && JSON.stringify(source[0].content) === JSON.stringify(this.originalTask)) start = 2;
    }

    // Typed inputs, newest first, matched to their history rows; an unmatched message with a host note's form is the host's.
    const hostNote = (content: string) => content === OUTPUT_LIMIT_NOTICE || content.startsWith("[Raw skill reload notice]")
      || content.startsWith(CHECKPOINT_MARKER) || content.startsWith(SUMMARY_MESSAGE_PREFIX) || isPanelReminder(content);
    const users = source.flatMap((message, index) => index >= start && message.role === "user" ? [index] : []);
    let rows = this.persistence ? this.persistence.store.recentUserInputs(this.persistence.sessionId, users.length) : [];
    const inputEntries = new Map<number, LedgerEntry & { sequence?: number }>();
    const reminderAt = new Set<number>();
    for (const index of [...users].reverse()) {
      const content = (source[index] as Extract<ModelMessage, { role: "user" }>).content;
      const row = rows[0];
      // A request cut by an earlier compaction still names its history row.
      if (row && (AgentSession.carriesInput(content, row.input) || cutNames(content, ledgerPointer(`history:${row.sequence}`)))) {
        inputEntries.set(index, { source: `history:${row.sequence}`, content: ledgerText(row.input), sequence: row.sequence });
        rows = rows.slice(1);
      } else if (typeof content === "string" && hostNote(content)) {
        if (isPanelReminder(content)) reminderAt.add(index);
      } else {
        // Without a matching row the boundary is unknown from here back; the message text is kept instead.
        rows = [];
        inputEntries.set(index, { source: `input:${randomUUID()}`, content: ledgerText(content) });
      }
    }
    // Panel reminders are replaced, not kept; the conversation is everything else after the host prefix.
    const positions = source.flatMap((_message, index) => index >= start && !reminderAt.has(index) ? [index] : []);
    const conversation = positions.map((index) => source[index]!);
    const units = transcriptSteps(conversation);
    if (units.length < 2) return { status: "noop", beforeBytes, afterBytes: beforeBytes };
    const unitStart: number[] = [];
    units.reduce((offset, unit) => { unitStart.push(offset); return offset + unit.length; }, 0);
    const unitOf = (index: number) => { let unit = 0; while (unit + 1 < units.length && unitStart[unit + 1]! <= index) unit++; return unit; };
    // A step lies wholly before or after the replay boundary: both are set between complete steps.
    const replayed = (unit: number) => positions[unitStart[unit]!]! < this.replayBefore;
    const sent = (unit: number, messages: readonly ModelMessage[] = units[unit]!) =>
      replayed(unit) ? projectReplayMessages(messages, messages.length) : [...messages];
    const typed = conversation.flatMap((_message, index) => inputEntries.has(positions[index]!) ? [index] : []);

    // Ledger entries of the active context, by occurrence: typed inputs and ask_user answers, at full length.
    const retainedText = new Map((this.ledgerState?.retained ?? []).map((entry) => [entry.source, entry.content]));
    const isAnswer = (message: ModelMessage): message is ToolMessage => message.role === "tool" && !message.result.isError
      && this.toolIdentity(message.name) === "builtin/ask_user";
    const active = conversation.flatMap((message, index): Array<{ index: number; entry: LedgerEntry; typed: boolean }> => {
      const input = inputEntries.get(positions[index]!);
      if (input) return [{ index, entry: { source: input.source, content: input.content }, typed: true }];
      if (isAnswer(message)) {
        const answer = `answer:${message.callId}`;
        return [{ index, entry: { source: answer, content: retainedText.get(answer) ?? resultText(message.result) }, typed: false }];
      }
      return [];
    });

    // Entries that left the context earlier: the stored ledger, or for a session compacted before it, what history proves.
    let base: LedgerEntry[] = [];
    let facts = emptyFacts();
    // A ledger state written only by tool-result clearing (no compaction yet) holds facts, not entries.
    if (this.ledgerState) facts = structuredClone(this.ledgerState.facts);
    if (this.ledgerState?.compactions) base = structuredClone(this.ledgerState.entries);
    else if (this.summaryText !== undefined) {
      const activeSequences = new Set([...inputEntries.values()].flatMap((entry) => entry.sequence === undefined ? [] : [entry.sequence]));
      const legacy = this.persistence && this.originalTask !== undefined
        ? this.persistence.store.legacyUserInputs(this.persistence.sessionId, this.originalTask) : undefined;
      const legacySequences = new Set(legacy?.map((row) => row.sequence));
      if (legacy && [...activeSequences].every((sequence) => legacySequences.has(sequence))) {
        base = legacy.filter((row) => !activeSequences.has(row.sequence)).map((row) => ({ source: `history:${row.sequence}`, content: ledgerText(row.input) }));
      } else {
        base = [...(this.originalTask !== undefined ? [{ source: "original_task", content: ledgerText(this.originalTask) }] : []),
          { source: LEGACY_NOTE_SOURCE, content: LEGACY_LEDGER_NOTE }];
      }
    }
    const n = (this.ledgerState?.compactions || (this.summaryText !== undefined ? 1 : 0)) + 1;

    // Allocation (§6.2.1), in the agent's calibrated estimate of the request the next turn sends.
    const modelConfig = this.options.provider.modelConfig;
    const budget = modelConfig.contextWindow === undefined ? Infinity
      : effectiveInputBudget(modelConfig.contextWindow, effectiveOutputTokens(modelConfig));
    const target = budget / 2;
    const calibration = this.tokenCalibration;
    const tokens = (value: string) => textTokens(value, calibration);
    const measure = (messages: readonly ModelMessage[]) => this.nextRequestSize(this.sendMessages(messages), false).tokens;
    const empty = measure([]);
    const stepTokens = (unit: readonly ModelMessage[]) => Math.max(0, measure(unit) - empty);
    const reminders = panelReminders(this.panels.snapshot()).map((content) => ({ role: "user" as const, content }));
    const skeleton = buildCheckpointMessage({ n, ledger: "", workingState: "", checkpoint: "" });
    const fixed = measure([{ role: "user", content: skeleton }, ...reminders]);
    const last = units.length - 1;
    const lastUnit = units[last]!.map((message) => structuredClone(message));
    const lastTokens = () => stepTokens(sent(last, lastUnit));
    const render: RenderOptions = { copies: new WeakMap() };
    // Results of the last step are head/tail-cut, largest first, each naming its saved copy, until the step fits `limit`.
    // The user's ask_user answers are cut only when the context has no room for them at all.
    const cutLastStep = (limit: number, answers = false) => {
      const order = lastUnit.flatMap((message, index) => message.role === "tool" && isAnswer(message) === answers ? [index] : [])
        .sort((a, b) => Buffer.byteLength(resultText((lastUnit[b] as ToolMessage).result)) - Buffer.byteLength(resultText((lastUnit[a] as ToolMessage).result)));
      for (const index of order) {
        const over = lastTokens() - limit;
        if (over <= 0) return;
        const message = lastUnit[index] as ToolMessage;
        // The marker naming the saved copy takes room too, so the cut goes a little further than the overflow.
        lastUnit[index] = cutToolResult(message, Math.max(512, Buffer.byteLength(resultText(message.result)) - Math.ceil(over * 2 / calibration) - 256), render);
      }
    };
    const keepTokens = settings.keepRecentTokens ?? Math.min(20000, Math.floor(0.25 * budget));
    cutLastStep(keepTokens);
    // The current turn's request group: the newest typed input, then the answers after it, unless the last step holds it.
    const ledgerEntries = [...base, ...active.filter((item) => unitOf(item.index) < last).map((item) => item.entry)];
    const newestTyped = [...active].reverse().find((item) => item.typed);
    const requestSource = newestTyped ? newestTyped.entry.source
      : [...base].reverse().find((entry) => entry.source !== LEGACY_NOTE_SOURCE && !entry.source.startsWith("answer:"))?.source;
    // The legacy coverage line is never left out (§6.2.1).
    const pinned = new Set<string>(base.some((entry) => entry.source === LEGACY_NOTE_SOURCE) ? [LEGACY_NOTE_SOURCE] : []);
    if (requestSource !== undefined && !(newestTyped && unitOf(newestTyped.index) === last)) {
      const position = ledgerEntries.findIndex((entry) => entry.source === requestSource);
      pinned.add(requestSource);
      for (const entry of ledgerEntries.slice(position + 1)) if (entry.source.startsWith("answer:")) pinned.add(entry.source);
    }
    const pinnedLimits = new Map<string, number>();
    const pinnedTokens = () => renderLedger(ledgerEntries.filter((entry) => pinned.has(entry.source)),
      { pinned, budgetTokens: 0, tokens, limits: pinnedLimits }).tokens;
    const thinking = provider.modelConfig.request?.kind === "anthropic" ? provider.modelConfig.request.thinking : undefined;
    const outputFloor = Math.min(settings.maxOutputTokens, Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, thinking?.type === "enabled" ? thinking.budgetTokens + 1 : 0));
    // A checkpoint of `output` tokens, with the note added when the model stops at its limit.
    const notice = Buffer.byteLength(SUMMARY_CUT_NOTICE);
    const reserve = (output: number) => Math.ceil((Math.min(4 * output, 7 * checkpointWords(output)) + notice) / 2 * calibration);
    // The largest output whose reserve fits `room`.
    const fitOutput = (room: number) => Math.floor((room - 1) / (2 * calibration) - notice / 4);
    let mandatory = fixed + lastTokens() + pinnedTokens();
    let outputBudget: number | undefined = settings.maxOutputTokens;
    let mechanical: string | undefined;
    let reason = settings.mechanical;
    if (reason === undefined && mandatory + reserve(outputBudget) > budget) {
      // Shorten the checkpoint to the room left, then fall back to the mechanical note.
      outputBudget = Math.min(settings.maxOutputTokens, fitOutput(budget - mandatory));
      if (outputBudget < outputFloor) reason = "no room left in the context for a new checkpoint";
    }
    if (reason !== undefined) {
      outputBudget = undefined;
      // The previous checkpoint is kept with the note; a note of an earlier fallback is replaced, not stacked.
      const note = mechanicalCheckpoint(reason);
      const prior = writtenCheckpoint(this.summaryText);
      mechanical = prior !== undefined && mandatory + tokens(`${prior}\n\n${note}`) <= budget ? `${prior}\n\n${note}` : note;
      // Then the last step's results, the turn's answers and its request are cut, each naming where its full text is.
      const over = () => fixed + lastTokens() + pinnedTokens() + tokens(mechanical!) - budget;
      const shrink = (bytes: number) => Math.max(512, bytes - Math.ceil(over() * 2 / calibration) - 128);
      cutLastStep(lastTokens() - over());
      if (over() > 0) cutLastStep(lastTokens() - over(), true);
      for (const entry of ledgerEntries.filter((item) => pinned.has(item.source) && item.source.startsWith("answer:")).reverse()) {
        if (over() <= 0) break;
        pinnedLimits.set(entry.source, shrink(Buffer.byteLength(entry.content)));
      }
      const request = lastUnit[0];
      if (over() > 0 && lastUnit.length === 1 && request?.role === "user" && newestTyped) {
        lastUnit[0] = { role: "user", content: cutUserInput(request.content, shrink(userTextBytes(request.content)), ledgerPointer(newestTyped.entry.source)) };
      }
      const pinnedRequest = ledgerEntries.find((item) => item.source === requestSource && pinned.has(item.source));
      if (over() > 0 && pinnedRequest) pinnedLimits.set(pinnedRequest.source, shrink(Buffer.byteLength(pinnedRequest.content)));
      mandatory = fixed + lastTokens() + pinnedTokens();
    }
    let left = target - mandatory - (outputBudget !== undefined ? reserve(outputBudget) : tokens(mechanical!));

    // Optional parts fill what the soft target leaves: working state, the rest of the ledger, the rest of the tail.
    const identity = (name: string) => this.toolIdentity(name);
    const processes = this.options.processes?.forSession(this.persistence?.sessionId ?? this.processSessionId).list()
      .filter((job) => job.state === "starting" || job.state === "running" || job.state === "stopping")
      .map((job) => ({ id: job.id, command: job.command, state: job.state })) ?? [];
    // Facts come from the stored messages not yet covered, before any cut or projection; the tail is covered from now on.
    const allFacts = collectFacts(source.slice(Math.min(this.ledgerState?.factsThrough ?? 0, source.length)), facts, identity);
    const workingFor = (maxBytes?: number) => renderWorkingState(allFacts,
      { cwd: this.options.cwd, compactions: n, processes, outputExists: existsSync }, maxBytes);
    const fullState = workingFor();
    let stateBytes: number | undefined;
    if (tokens(fullState) <= left) { stateBytes = WORKING_STATE_BYTES; left -= tokens(fullState); }
    else if (left * 2 / calibration >= 512) { stateBytes = Math.floor(left * 2 / calibration); left = 0; }
    const pinnedUsed = pinnedTokens();
    const ledger = renderLedger(ledgerEntries, { pinned, tokens, limits: pinnedLimits,
      budgetTokens: Math.max(pinnedUsed, Math.min(LEDGER_CAP_TOKENS, pinnedUsed + Math.max(0, left))) });
    left -= ledger.tokens - pinnedUsed;
    let tailStart = last;
    let tailTokens = lastTokens();
    while (tailStart > 1) {
      const cost = stepTokens(sent(tailStart - 1));
      if (tailTokens + cost > keepTokens || cost > left) break;
      tailStart--;
      tailTokens += cost;
      left -= cost;
    }
    // keep_recent_turns is a lower bound when those turns fit the target and leave something to summarize.
    const turnStarts = typed.map(unitOf);
    const turnStart = settings.keepRecentTurns > 0 ? turnStarts[turnStarts.length - settings.keepRecentTurns] : undefined;
    if (turnStart !== undefined && turnStart >= 1 && turnStart < tailStart) {
      let cost = 0;
      for (let unit = turnStart; unit < tailStart; unit++) cost += stepTokens(sent(unit));
      if (cost <= left) { tailStart = turnStart; left -= cost; }
    }
    const headSteps = units.slice(0, tailStart).flat();
    // A head of typed inputs alone has nothing the ledger does not already keep verbatim, unless the last step had to be cut.
    if (!headSteps.some((message) => message.role !== "user") && JSON.stringify(lastUnit) === JSON.stringify(units[last])) {
      return { status: "noop", beforeBytes, afterBytes: beforeBytes };
    }
    // The summarizer reads what the provider would have been sent; the tail keeps the stored steps and their replay boundary.
    const head = units.slice(0, tailStart).flatMap((_unit, unit) => sent(unit));
    const tail = [...units.slice(tailStart, last).flat().map((message) => structuredClone(message)), ...lastUnit];
    const tailReplayed = units.slice(tailStart).reduce((count, unit, offset) => count + (replayed(tailStart + offset) ? unit.length : 0), 0);
    const replayBefore = tailReplayed ? 1 + tailReplayed : 0;
    // Whatever the checkpoint, the rest of the new context stays within the input budget.
    const retryCap = outputBudget === undefined || budget === Infinity ? undefined
      : Math.max(outputBudget, fitOutput(budget - (target - left - reserve(outputBudget))));

    const entries = new Map<number, { entry: UsageRecord; rawIndex?: number }>();
    let onAbort: (() => void) | undefined;
    try {
      let checkpoint = mechanical;
      let usage: unknown;
      if (outputBudget !== undefined) {
        // Only the summary request waits; the abort promise exists only while it does, so it is always observed.
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("compaction aborted"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        const work = await Promise.race([summarizeTranscript(head, provider, {
          maxOutputTokens: outputBudget, maxRetryOutputTokens: retryCap, prior: this.summaryText, instructions: settings.instructions,
          maxOutputTokensDefaulted: settings.maxOutputTokensDefaulted || outputBudget !== settings.maxOutputTokens,
          timeoutMs: this.options.requestTimeoutMs, signal: controller.signal, cacheKey: `${this.cacheKey}:compact`,
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
        if (controller.signal.aborted || work.status === "cancelled") return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
        checkpoint = work.summary;
        usage = work.usage;
      }
      const retained = loadedSkillNames(tail);
      const selectedNames = new Set(this.selectedSkills.map((skill) => skill.name));
      const missing = this.skillVisibility.loaded.filter((name) => selectedNames.has(name) && !retained.has(name));
      const priorNotices = tail.flatMap((message) => text(message)?.startsWith("[Raw skill reload notice]") ? [text(message)!] : []).join("\n");
      const uncovered = missing.filter((name) => !priorNotices.includes(name)).sort();
      const notice = uncovered.length
        ? `[Raw skill reload notice] Loaded skill content was removed by compaction: ${uncovered.join(", ")}. Call load_skill again before relying on earlier instructions.`
        : undefined;
      const workingState = stateBytes === undefined ? "" : workingFor(stateBytes);
      // A compaction that succeeds reminds the model of the open summary panels (§10); reminders of an earlier one are replaced.
      const build = (body: string): ModelMessage[] => [
        { role: "user", content: buildCheckpointMessage({ n, ledger: ledger.text, workingState, checkpoint: body }) },
        ...tail,
        ...(notice ? [{ role: "user" as const, content: notice }] : []),
        ...reminders,
      ];
      // The checkpoint's size was only estimated (§6.2.1). One that would overflow the input budget keeps its start and end
      // around a pointer to the compaction record, which stores it whole; without room for that, the mechanical note replaces it.
      let placed = checkpoint!;
      let replacement = build(placed);
      for (let attempt = 0; attempt < 4 && mechanical === undefined; attempt++) {
        const over = measure(projectReplayMessages(replacement, replayBefore)) - budget;
        if (over <= 0) break;
        const room = Buffer.byteLength(placed) - Math.ceil(over * 2 / calibration) - 64;
        placed = room >= 1024 ? cutText(checkpoint!, room, "the compaction record in the session history")
          : mechanicalCheckpoint("no room left in the context for a new checkpoint");
        replacement = build(placed);
        if (room < 1024) break;
      }
      const finalBytes = Buffer.byteLength(JSON.stringify(replacement), "utf8");
      if (finalBytes >= beforeBytes) return { status: "not_smaller", beforeBytes, afterBytes: finalBytes };
      // A mechanical checkpoint makes no request, so an abort is checked here before anything is committed.
      if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
      const leaving = active.filter((item) => unitOf(item.index) < tailStart).map((item) => item.entry);
      // Answers that stay in the tail but whose copy there is cut, or was by an earlier compaction, keep their full text aside.
      const cutAnswers = new Set(lastUnit.flatMap((message, index) => isAnswer(message)
        && JSON.stringify(message) !== JSON.stringify(units[last]![index]) ? [`answer:${message.callId}`] : []));
      const kept = active.filter((item) => unitOf(item.index) >= tailStart && !item.typed
        && (cutAnswers.has(item.entry.source) || retainedText.has(item.entry.source))).map((item) => item.entry);
      const ledgerState: CompactionLedgerState = { entries: [...base, ...leaving], facts: allFacts, factsThrough: replacement.length, compactions: n,
        ...(kept.length ? { retained: kept } : {}), retryArmed: true };
      const committedDetails: CompactionDetails = { ...details, status: "compacted", summary: checkpoint!, beforeBytes, afterBytes: finalBytes,
        afterTokens: this.nextRequestSize(this.sendMessages(projectReplayMessages(replacement, replayBefore)), false).tokens };
      this.durable((store, sessionId, owner) => store.replaceAgentContext(sessionId, owner, replacement,
        { summaryText: checkpoint!, ledger: ledgerState, rawUsage: this.rawUsage, usageEntries: this.usageEntries,
          tokenCalibration: this.tokenCalibration, replayBefore, anchor: null, ...(notice ? { skillNotice: notice } : {}) },
        false, [{ kind: "compaction", payload: this.visiblePayload({ ...committedDetails }) }]));
      Object.assign(details, committedDetails);
      this.messages = structuredClone(replacement);
      this.anchor = undefined;
      this.replayBefore = replayBefore;
      this.summaryText = checkpoint;
      this.ledgerState = ledgerState;
      this.replayRetryArmed = true;
      return { status: "compacted", beforeBytes, afterBytes: finalBytes, ...(usage !== undefined ? { usage } : {}) };
    } catch (error) {
      if (this.persistenceError) throw this.persistenceError;
      if (controller.signal.aborted) return { status: "cancelled", beforeBytes, afterBytes: beforeBytes };
      throw error;
    } finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  }

  /**
   * Tier-0 clearing (docs/compaction-v2-design.md §6.8): old, large tool results before the protected tail become stubs
   * naming a secured copy, until the next request is at most 45% of the input budget. Commits only when it frees at least
   * `minFreedTokens`; true when it committed.
   */
  private clearWork(inputBudget: number, minFreedTokens: number, cause: "threshold" | "fallback"): boolean {
    // One basis for the current size, the savings and the size after: the calibrated byte estimate of what is sent. A size
    // anchored to provider usage is dropped by the replacement, so the target is checked the way the next request is.
    const measure = (messages: readonly ModelMessage[]) => this.nextRequestSize(this.sendMessages(projectReplayMessages(messages, this.replayBefore)), false).tokens;
    const currentTokens = measure(this.messages);
    const messageTokens = (message: ModelMessage, index: number) => {
      const sent = this.sendMessages(projectReplayMessages([message], index < this.replayBefore ? 1 : 0));
      return Math.ceil((estimateRequestTokens("", sent, []) - estimateRequestTokens("", [], [])) * this.tokenCalibration);
    };
    // The protected tail: the last step, then earlier steps up to keep_recent_tokens, as compaction keeps them.
    const units = transcriptSteps(this.messages);
    const keepTokens = this.options.compact?.keepRecentTokens ?? Math.min(20000, Math.floor(0.25 * inputBudget));
    let protectedFrom = this.messages.length;
    const stepTokens = (unit: number) => units[unit]!.reduce((sum, message, offset) => sum + messageTokens(message, protectedFrom - units[unit]!.length + offset), 0);
    let kept = 0;
    if (units.length) { kept = stepTokens(units.length - 1); protectedFrom -= units.at(-1)!.length; }
    for (let unit = units.length - 2; unit >= 0; unit--) {
      const cost = stepTokens(unit);
      if (kept + cost > keepTokens) break;
      kept += cost;
      protectedFrom -= units[unit]!.length;
    }
    const reminders = [...panelReminders(this.panels.snapshot()),
      ...this.messages.flatMap((message) => message.role === "user" && typeof message.content === "string" && isPanelReminder(message.content) ? [message.content] : [])];
    const exempt = (message: ToolMessage) => {
      const identity = this.toolIdentity(message.name);
      return identity === "builtin/ask_user" || identity === "builtin/load_skill"
        || namedByReminder(message, reminders);
    };
    const outcome = clearToolResults(this.messages, { protectedFrom, currentTokens, targetTokens: Math.floor(CLEAR_TARGET_RATIO * inputBudget),
      minFreedTokens, messageTokens, exempt, measure });
    if (!outcome) return false;
    // Facts of the steps whose results become stubs are folded first, so the working state keeps them (§6.2).
    const covered = Math.min(this.ledgerState?.factsThrough ?? 0, this.messages.length);
    const through = Math.max(covered, protectedFrom);
    const facts = collectFacts(this.messages.slice(covered, through), this.ledgerState?.facts ?? emptyFacts(), (name) => this.toolIdentity(name));
    // The copies clearing wrote are saved outputs too; the stubs naming them may later be summarized away.
    for (const { path } of outcome.cleared) if (!facts.outputs.includes(path)) facts.outputs.push(path);
    const ledger: CompactionLedgerState = { ...(this.ledgerState ?? { entries: [], compactions: 0 }), facts, factsThrough: through, retryArmed: true };
    const afterTokens = currentTokens - outcome.freedTokens;
    this.durable((store, sessionId, owner) => store.replaceAgentContext(sessionId, owner, outcome.messages, { ledger, anchor: null }, false,
      [{ kind: "context_clearing", payload: this.visiblePayload({ id: randomUUID(), cause, beforeTokens: currentTokens, afterTokens,
        freedTokens: outcome.freedTokens, results: outcome.cleared }) }]));
    if (this.persistenceError) throw this.persistenceError;
    this.messages = outcome.messages;
    this.anchor = undefined;
    this.ledgerState = ledger;
    // The request after clearing replays reasoning around stubs; a provider that rejects it gets the projected retry.
    this.replayRetryArmed = true;
    return true;
  }

  private async compactAttempt(provider: ProviderAdapter, settings: CompactWorkSettings, controller: AbortController,
    cause: CompactionDetails["cause"], onEvent?: (event: RunEvent) => void): Promise<CompactResult> {
    const details: CompactionDetails = { id: randomUUID(), cause, status: "running", keepRecentTurns: settings.keepRecentTurns,
      beforeTokens: this.estimatedContextTokens(), beforeBytes: Buffer.byteLength(JSON.stringify(this.messages)) };
    const emit = (event: RunEvent) => onEvent?.(structuredClone({ ...event,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) }));
    this.recordVisible("compaction", { ...details });
    try {
      emit({ type: "compact_start", estimatedTokens: details.beforeTokens, details });
      const result = await this.compactWork(provider, settings, controller, details, (raw) => emit({ type: "usage", raw }));
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
      { onReceipt: (receipt) => this.hookReceipt(receipt, onEvent) });
    }
    finally {
      this.ownedInteractions?.close();
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
    const maxOutputTokens = options.maxOutputTokens ?? defaultCompactOutputTokens((options.provider ?? this.options.provider).modelConfig);
    if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
      || (options.keepRecentTokens !== undefined && (!Number.isSafeInteger(options.keepRecentTokens) || options.keepRecentTokens < 1))) {
      return Promise.reject(new Error("invalid compaction settings"));
    }
    this.currentState = "compacting";
    this.heartbeat?.ref();
    const controller = new AbortController();
    this.controller = controller;
    const defaulted = options.maxOutputTokens === undefined || options.maxOutputTokensDefaulted === true;
    const instructions = options.instructions ?? this.options.compact?.instructions;
    const keepRecentTokens = options.keepRecentTokens ?? this.options.compact?.keepRecentTokens;
    const task = this.compactAttempt(options.provider ?? this.options.provider, { keepRecentTurns, keepRecentTokens, maxOutputTokens,
      maxOutputTokensDefaulted: defaulted, instructions }, controller, "manual", onEvent).finally(() => {
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
  runPanelAction(request: { panel: string; action: string; block?: string; item?: string; viewInstanceId?: string }, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
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

  private async panelAction(request: { panel: string; action: string; block?: string; item?: string; viewInstanceId?: string }, controller: AbortController,
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
    const historical = request.viewInstanceId && this.persistence
      ? this.persistence.store.getToolView(this.persistence.sessionId, request.viewInstanceId) : undefined;
    if (request.viewInstanceId && (!historical || historical.panelId !== request.panel)) return fail("unknown_view", "This tool view does not exist in the session");
    const stored = historical ?? this.panels.snapshot().find((panel) => panel.panelId === request.panel);
    let resolved;
    try { resolved = resolveAction(declaration, request, stored?.document ?? null); }
    catch (error) { return fail("invalid_action", (error as Error).message); }
    if (resolved.action.kind !== "tool") return fail("invalid_action", "only tool actions run on the host");
    const operationId = this.currentTurnId!;
    const hookRequest = () => ({ cwd: this.options.cwd, agent_id: this.options.provider.modelConfig.agentName,
      ...(this.persistence ? { session_id: this.persistence.sessionId } : {}), turn_id: operationId });
    this.panels.setListener((event) => emit({ type: "panel_update", ...event }));
    const panelCall = this.panels.begin(operationId, info, "user_action", this.panelScope(operationId));
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
        ...(this.options.processes ? { processes: this.options.processes.forSession(this.persistence?.sessionId ?? this.processSessionId), commandActivity: this.options.processes.commands.forSession(this.persistence?.sessionId ?? this.processSessionId) } : {}),
        interactions: this.interactionContext(operationId, info.owner, panelCall, controller.signal),
        panels: panelCall.context, onPanelUpdates: (updates) => panelCall.collect(updates), onHandlerSettled: () => this.settleHandler(operationId, panelCall),
        ...(this.options.hooks ? { onHook: (event: HookEventName, identity: string, name: string, args: Record<string, unknown>, result?: ToolResult, effects?: Record<string, unknown>) =>
          this.options.hooks!.run(event, { ...hookRequest(), tool: { identity, name, source: "user_action", arguments: args, ...(effects ? { effects } : {}), ...(result ? { result } : {}) } },
            // Observing hooks get their own timeout_ms; only an interrupted run hurries them (HOOK_TEARDOWN_MS).
            { ...(event === "PreToolUse" ? { signal: controller.signal } : { hurry: { signal: controller.signal, graceMs: HOOK_TEARDOWN_MS },
              ...(controller.signal.aborted ? { deadline: Date.now() + HOOK_TEARDOWN_MS } : {}) }),
              onReceipt: (receipt) => this.hookReceipt(receipt, emit) }) } : {}),
        onStart: () => { started = true; },
      });
    } catch (error) {
      panelCall.rollback();
      return controller.signal.aborted ? { status: "cancelled", steps: 0 } : fail("action_error", (error as Error).message);
    }
    if (!started) { panelCall.rollback(); if (controller.signal.aborted) return { status: "cancelled", steps: 0 }; return fail(dispatched.code ?? "action_error", dispatched.content.find((block) => block.type === "text")?.text ?? "the action did not run"); }
    if (controller.signal.aborted) { panelCall.rollback(); return { status: "cancelled", steps: 0 }; }
    try {
      const settled = panelCall.settle(dispatched.content.length === 0);
      const text = truncateBytes([...dispatched.content.flatMap((block) => block.type === "text" ? [block.text] : []), ...settled.lines].join("\n"), 1024);
      // The receipt for the panel the user clicked: the update the tool made to it, or its unchanged current state.
      const local = request.panel.slice(hash + 1);
      const own = settled.receipts.find((receipt) => receipt.panel === local && receipt.owner === owner)
        ?? { ...panelCall.unchangedReceipt(local), ...(historical ? { view: historical.view,
          title: historical.document.title ?? historical.declaration.title, revision: historical.revision,
          summary: historical.document.summary ?? "", status: historical.document.status ?? "active" } : {}) };
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
    let continuations = 0;
    let continuedText = "";
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
            { hurry: { signal: controller.signal, graceMs: HOOK_TEARDOWN_MS },
              ...(terminalDeadline !== undefined || result.status === "cancelled" ? { deadline: terminalDeadline ?? Date.now() + HOOK_TEARDOWN_MS } : {}),
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
    const completedWriteCalls = new Set<string>();
    const appendResult = (call: ModelToolCall, dispatchedResult: ToolResult, panelCall?: PanelCall) => {
      let result = dispatchedResult;
      let panelWrites: PanelWrites | undefined;
      let panelRecords: VisibleRecord[] = [];
      const preserveCompletedWrites = this.toolIdentity(call.name) === "builtin/write_file" && completedWriteCalls.has(call.id)
        && this.options.registry.panelDeclarations(call.name)?.declarations.every(panel => panel.id === "files_changed");
      if (panelCall && controller.signal.aborted && !preserveCompletedWrites) panelCall.rollback();
      else if (panelCall) {
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
      emit({ type: "tool_result", id: call.id, name: call.name, result: publicResult, display: projected,
        ...(panelRecords.length ? { panelReceipts: panelRecords.map((record) => structuredClone(record.payload) as unknown as PanelReceipt) } : {}) });
    };
    const firstTask = this.originalTask === undefined;
    // Thrash guard (§6.5): the class of the last automatic compaction or fallback, and the step count when tier 1 last ran.
    let compactionClass: "effective" | "weak" | "stuck" = "effective";
    let summarizedAt = -1;
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
        let measured = false;
        const compact = this.options.compact;
        if (compact && (compact.triggerTokens !== undefined || compact.clearTokens !== undefined)) {
          const modelConfig = this.options.provider.modelConfig;
          const context = modelConfig.contextWindow!;
          const outputReserve = effectiveOutputTokens(modelConfig);
          const inputBudget = effectiveInputBudget(context, outputReserve);
          const estimate = () => {
            const size = this.nextRequestSize();
            baseEstimate = size.base;
            measured = size.measured;
            return size.tokens;
          };
          requestEstimate = estimate();
          // Tier 0 (§6.8): below the compaction trigger, old tool results are cleared to saved copies first.
          if (compact.clearTokens !== undefined && requestEstimate >= compact.clearTokens
            && (compact.triggerTokens === undefined || requestEstimate < compact.triggerTokens)
            && this.clearWork(inputBudget, CLEAR_MIN_FREED_TOKENS, "threshold")) requestEstimate = estimate();
          const trigger = compact.triggerTokens;
          if (trigger !== undefined && requestEstimate >= trigger) {
            if (controller.signal.aborted) return finish(interrupted());
            const settings: CompactWorkSettings = { keepRecentTurns: compact.keepRecentTurns, keepRecentTokens: compact.keepRecentTokens,
              maxOutputTokens: compact.maxOutputTokens, maxOutputTokensDefaulted: compact.maxOutputTokensDefaulted === true, instructions: compact.instructions };
            const classOf = (tokens: number) => tokens < 0.7 * trigger ? "effective" as const : tokens < trigger ? "weak" as const : "stuck" as const;
            // An automatic attempt never ends the turn: a failure is a compact_error warning, and the fallback takes over.
            const attempt = async (work: CompactWorkSettings): Promise<CompactResult | "failed" | "stop"> => {
              try {
                const outcome = await this.compactAttempt(this.options.provider, work, controller, "automatic", emit);
                return controller.signal.aborted || outcome.status === "cancelled" ? "stop" : outcome;
              } catch {
                return this.persistenceError || controller.signal.aborted ? "stop" : "failed";
              }
            };
            // The fallback chain (§6.7, steps 1–3) makes no model call: forced clearing, then a mechanical checkpoint whose
            // tail keeps only the steps that fit, down to the last one.
            const fallback = async (reason: string): Promise<boolean> => {
              if (this.clearWork(inputBudget, 0, "fallback")) requestEstimate = estimate();
              if (requestEstimate >= trigger) {
                if (await attempt({ ...settings, keepRecentTurns: 0, mechanical: reason }) === "stop") return false;
                requestEstimate = estimate();
              }
              compactionClass = classOf(requestEstimate);
              return true;
            };
            // Tier 1 needs a completed step since it last ran. After a weak outcome the fallback goes first; after a stuck one,
            // or without progress, only the fallback runs.
            const progressed = steps > summarizedAt;
            let summarize = progressed && compactionClass === "effective";
            if (compactionClass === "weak") {
              if (!await fallback("the context refilled soon after the last checkpoint")) return finish(interrupted());
              summarize = progressed;
            } else if (!summarize && !await fallback("compaction earlier in this turn did not bring the context under the threshold")) {
              return finish(interrupted());
            }
            if (summarize && requestEstimate >= trigger) {
              summarizedAt = steps;
              const outcome = await attempt(settings);
              if (outcome === "stop") return finish(interrupted());
              requestEstimate = estimate();
              compactionClass = classOf(requestEstimate);
              if (compactionClass === "stuck") {
                const reason = outcome === "failed" ? "the checkpoint request failed"
                  : outcome.status === "compacted" ? "the context was still over the compaction threshold after the checkpoint"
                  : outcome.status === "not_smaller" ? "the checkpoint did not make the context smaller"
                  : "nothing older than the recent steps could be summarized";
                if (!await fallback(reason)) return finish(interrupted());
              }
            }
          }
          // Only a size anchored to provider-reported usage may stop the run; a byte estimate alone can overstate
          // tokens severalfold, so the request is sent and the provider decides.
          if (compact.triggerTokens !== undefined && measured && requestEstimate > inputBudget) return finish({ status: "error", steps, code: "context_budget_exceeded",
            message: `estimated input ${requestEstimate} exceeds budget ${inputBudget}` });
        }
        steps++;
        const usageEntry: UsageRecord = { method: this.options.provider.modelConfig.method, provider: this.options.provider.modelConfig.provider, raw: undefined };
        this.usageEntries.push(usageEntry);
        this.reported = undefined;
        this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner,
          { rawUsage: this.rawUsage, usageEntries: this.usageEntries }));
        let usageIndex: number | undefined;
        const recordUsage = (raw: unknown) => {
          if (controller.signal.aborted) return;
          usageEntry.raw = structuredClone(raw);
          const normalized = normalizeUsage(this.options.provider.modelConfig.method, raw, this.options.provider.modelConfig.provider);
          const actual = normalized.inputTokensTotal;
          if (baseEstimate > 0 && actual !== undefined) this.tokenCalibration = Math.max(this.tokenCalibration, actual / baseEstimate * 1.1);
          // Only a complete report (input and output counts) describes the conversation; a partial one leaves the estimate in charge.
          this.reported = actual === undefined || normalized.outputTokens === undefined ? undefined : actual + normalized.outputTokens;
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
          const request = () => Promise.race([this.options.provider.generate({
            system: this.options.system,
            messages: this.sendMessages(),
            tools: this.schemaView,
            timeoutMs: this.options.requestTimeoutMs,
            cacheKey: this.cacheKey,
            signal: controller.signal,
            onTextDelta: (text) => { if (!controller.signal.aborted) emit({ type: "text_delta", text }); },
            onReasoningDelta: (text) => { if (!controller.signal.aborted) emit({ type: "reasoning_delta", text }); },
            onUsage: recordUsage,
          }), aborted]);
          const retry = this.replayRetryArmed;
          if (retry) {
            // The first request after a compaction consumes the retry, in this runtime or a later one.
            this.replayRetryArmed = false;
            if (this.ledgerState?.retryArmed) {
              const { retryArmed: _consumed, ...ledger } = this.ledgerState;
              this.ledgerState = ledger;
              this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner, { ledger }));
            }
          }
          try { turn = await request(); }
          catch (error) {
            // Replayed reasoning the provider rejects after compaction is projected to text, as a model switch does (§6.2).
            if (!retry || controller.signal.aborted || !isReasoningRejection(error) || this.replayBefore >= this.messages.length) throw error;
            const replayBefore = this.messages.length;
            this.durable((store, sessionId, owner) => store.updateAgentMetadata(sessionId, owner, { replayBefore }));
            this.replayBefore = replayBefore;
            turn = await request();
          }
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
          continuedText += turn.text;
          // An answer cut at the output token limit continues in a new request instead of ending the run half written.
          if (turn.truncated && continuations < MAX_OUTPUT_CONTINUATIONS && steps < this.options.maxSteps) {
            continuations++;
            this.commitMessage({ role: "user", content: OUTPUT_LIMIT_NOTICE });
            continue;
          }
          return finish({ status: "completed", steps, text: continuedText });
        }
        continuations = 0;
        continuedText = "";
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
          const panelCall = panelInfo ? this.panels.begin(call.id, panelInfo, "tool", this.panelScope()) : undefined;
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
              ...(this.toolIdentity(call.name) === "builtin/write_file" ? { onWriteCompleted: () => { completedWriteCalls.add(call.id); } } : {}),
              ...(this.options.processes ? { processes: this.options.processes.forSession(this.persistence?.sessionId ?? this.processSessionId), commandActivity: this.options.processes.commands.forSession(this.persistence?.sessionId ?? this.processSessionId) } : {}),
              interactions: this.interactionContext(call.id, panelInfo?.owner ?? call.name, panelCall, controller.signal),
              onHandlerSettled: () => this.settleHandler(call.id, panelCall),
              ...(panelCall ? { panels: panelCall.context, onPanelUpdates: (updates) => panelCall.collect(updates) } : {}),
              ...(this.options.hooks ? { onHook: (event: HookEventName, identity: string,
                name: string, args: Record<string, unknown>, result?: ToolResult, effects?: Record<string, unknown>) => this.options.hooks!.run(event,
                { ...hookRequest(), tool: { identity, name, source: "model", arguments: args, ...(effects ? { effects } : {}), ...(result ? { result } : {}) } },
                { ...(event === "PreToolUse" ? { signal: controller.signal } : { hurry: { signal: controller.signal, graceMs: HOOK_TEARDOWN_MS },
                  ...(controller.signal.aborted ? { deadline: terminalDeadline ??= Date.now() + HOOK_TEARDOWN_MS } : {}) }),
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
