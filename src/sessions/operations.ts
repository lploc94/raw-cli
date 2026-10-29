import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { InteractionService } from "../interactions/service.js";
import type { RunEvent, RunResult } from "../agent.js";
import type { SessionAgent } from "../backends/types.js";
import type { CompactOptions, CompactResult } from "../compact.js";
import type { CompactSettings } from "../config.js";
import type { ResolvedModelConfig } from "../llm/types.js";
import type { RequestOverride } from "../request-controls.js";
import type { ToolContext } from "../tools/primitives.js";
import type { UserInput } from "../llm/types.js";
import { measureSession, type MeasureOptions, type SessionMetrics } from "./metrics.js";
import { approvalTimeoutMs, SessionOperationError, terminalOperationStates, type OperationIntent, type OperationState, type SessionOperation } from "./operation-types.js";
import { attachSessionRuntime } from "./runtime.js";
import type { QueuedIntent, SessionOwner, SessionStore, SessionSummary } from "./store.js";
import type { QueuedInputView } from "./view.js";


export type { OperationIntent, OperationState, SessionOperation } from "./operation-types.js";
export { SessionOperationError } from "./operation-types.js";

export interface SessionRuntime {
  capabilities?: SessionMetrics["capabilities"];
  agent: SessionAgent;
  /** Raw's loop measures against its model config; a backend without one supplies `measure`. */
  modelConfig?: Readonly<ResolvedModelConfig>;
  measure?: (options: MeasureOptions) => SessionMetrics;
  compactOptions?: CompactOptions;
  compact?: Readonly<CompactSettings>;
  close(): Promise<void>;
}
export type AttachSessionRuntime = (options: {
  store: SessionStore; session: SessionSummary; operation: SessionOperation; owner: SessionOwner;
  signal: AbortSignal; processes?: ProcessSupervisor; interactions?: InteractionService; approve?: ToolContext["approve"]; env?: NodeJS.ProcessEnv;
  /** Per-turn request override, applied to this operation's provider request only. */
  request?: RequestOverride;
}) => Promise<SessionRuntime>;

export type OperationEvent = { sessionId: string; operationId: string } & (
  | { type: "operation"; operation: SessionOperation }
  | { type: "event"; event: RunEvent }
  | { type: "host_error"; message: string }
  /** The session's waiting messages changed; `items` is the full list. */
  | { type: "inputs"; items: QueuedInputView[] }
);
interface ActiveOperation {
  sessionId: string;
  owner: SessionOwner;
  /** Structured turn input for this process only; the persisted operation keeps the text. */
  blocks?: UserInput;
  /** Per-turn request override for this process only; never persisted. */
  request?: RequestOverride;
  controller: AbortController;
  done: Promise<SessionOperation>;
  agent?: SessionAgent;
  measure?: () => SessionMetrics;
}

export class SessionOperations {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly observers = new Set<(event: OperationEvent) => void>();
  private closed = false;
  constructor(private readonly options: {
    store: SessionStore; attach?: AttachSessionRuntime; env?: NodeJS.ProcessEnv;
    interactions?: InteractionService;
    processes?: ProcessSupervisor;
    approve?: (operation: SessionOperation) => ToolContext["approve"];
  }) { options.store.recoverOperations(); }

  subscribe(observer: (event: OperationEvent) => void): () => void {
    this.observers.add(observer); return () => { this.observers.delete(observer); };
  }
  private publish(event: OperationEvent): void {
    for (const observer of this.observers) {
      try { observer(structuredClone(event)); } catch { /* Observers never own execution. */ }
    }
  }
  owns(operationId: string): boolean { return this.active.has(operationId); }
  activeIds(): string[] { return [...this.active.keys()]; }
  metrics(operationId: string): SessionMetrics | undefined { return this.active.get(operationId)?.measure?.(); }
  approvalTimeout(_operationId: string): number { return approvalTimeoutMs(this.options.env); }
  toolIdentity(operationId: string, name: string): string | undefined { return this.active.get(operationId)?.agent?.toolIdentity(name); }

  submit(intent: OperationIntent, blocks?: UserInput, request?: RequestOverride): SessionOperation {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    const { operation, owner } = this.options.store.acceptOperation(intent);
    if (!owner) return operation;
    this.launch(operation, owner, blocks, request);
    return structuredClone(operation);
  }

  /**
   * Sends a turn message: it starts a turn when the session is idle, and waits in the session's queue while a turn of
   * this process runs (docs/sessions.md). `interrupt` also stops that turn, and the message starts the next one. A session
   * held by another process answers `busy`.
   */
  enqueue(intent: OperationIntent, options: { blocks?: UserInput; request?: RequestOverride; mode: QueuedIntent["mode"] }):
    { operation: SessionOperation } | { queued: QueuedInputView } {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    const holder = this.holder(intent.sessionId);
    if (holder) {
      try {
        const queued = this.options.store.enqueueInput(intent.sessionId, holder.owner, { ...intent, mode: options.mode,
          ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.request ? { request: options.request } : {}) });
        this.publishInputs(intent.sessionId, holder.operationId);
        // Marked and stopped in one synchronous call, so the ending turn's successor choice sees this message.
        if (options.mode === "interrupt") this.cancel(holder.operationId);
        return { queued };
      } catch (error) {
        // The turn ended between the lookup and the write: the session is free, so this message starts the next turn.
        if (!(error instanceof Error && error.message === "session ownership lost")) throw error;
      }
    }
    return { operation: this.submit(intent, options.blocks, options.request) };
  }

  /** Sends a waiting, paused or blocked message now: it interrupts the running turn, or starts a turn when the session is idle. */
  sendNow(sessionId: string, inputId: string): { operation: SessionOperation } | { queued: QueuedInputView } {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    const holder = this.holder(sessionId);
    if (holder) {
      try {
        const queued = this.options.store.markInterrupt(sessionId, holder.owner, inputId);
        this.publishInputs(sessionId, holder.operationId);
        this.cancel(holder.operationId);
        return { queued };
      } catch (error) { if (!(error instanceof Error && error.message === "session ownership lost")) throw error; }
    }
    const started = this.options.store.startQueuedInput(sessionId, inputId);
    this.launch(started.operation, started.owner, typeof started.input === "string" ? undefined : started.input, started.request);
    this.publishInputs(sessionId, started.operation.id);
    return { operation: structuredClone(started.operation) };
  }

  /** The operation of this process that holds the session's lease now, if any. */
  private holder(sessionId: string): { operationId: string; owner: SessionOwner } | undefined {
    let found: { operationId: string; owner: SessionOwner } | undefined;
    for (const [operationId, active] of this.active) {
      if (active.sessionId === sessionId && (!found || active.owner.generation > found.owner.generation)) found = { operationId, owner: active.owner };
    }
    return found;
  }

  publishInputs(sessionId: string, operationId = ""): void {
    this.publish({ type: "inputs", sessionId, operationId, items: this.options.store.queuedInputs(sessionId) });
  }

  private launch(operation: SessionOperation, owner: SessionOwner, blocks?: UserInput, request?: RequestOverride): void {
    const controller = new AbortController();
    let resolveDone!: (operation: SessionOperation) => void;
    let rejectDone!: (error: unknown) => void;
    const active: ActiveOperation = { sessionId: operation.sessionId, owner, ...(blocks ? { blocks } : {}), ...(request ? { request } : {}),
      controller, done: new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }) };
    // A detached HTTP client is not responsible for consuming a terminal persistence error.
    void active.done.catch(() => {});
    this.active.set(operation.id, active);
    const heartbeat = setInterval(() => {
      try { this.options.store.renewSession(operation.sessionId, owner); }
      catch { controller.abort(); active.agent?.abort(); }
    }, 5_000);
    this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
    setImmediate(() => {
      void this.execute(operation, owner, active).then(resolveDone, rejectDone).finally(() => {
        clearInterval(heartbeat); this.active.delete(operation.id);
      });
    });
  }

  private async execute(operation: SessionOperation, owner: SessionOwner, active: ActiveOperation): Promise<SessionOperation> {
    const { store } = this.options;
    const startedAt = performance.now();
    let runtime: SessionRuntime | undefined;
    let state: OperationState = "error";
    let result: RunResult | CompactResult | undefined;
    let error: SessionOperation["error"];
    let metrics: SessionMetrics | undefined;
    let startedTools = 0; let failedTools = 0; let firstRequest = 0;
    const publishState = (next: OperationState) => {
      operation = store.updateOperation(operation.id, owner, next);
      this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
    };
    const event = (event: RunEvent) => {
      // The commit set the operation's committed position; clients learn the agent has the message from the operation.
      if (event.type === "input_committed") {
        operation = store.getOperation(operation.id) ?? operation;
        this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
        return;
      }
      if (event.type === "queued_input") { this.publishInputs(operation.sessionId, operation.id); return; }
      if (event.type === "tool_start") startedTools++;
      if (event.type === "tool_result" && (event.display?.failed ?? event.result.isError)) failedTools++;
      this.publish({ type: "event", sessionId: operation.sessionId, operationId: operation.id, event });
    };
    try {
      publishState("starting");
      if (active.controller.signal.aborted) throw new Error("operation cancelled");
      const session = store.getSession(operation.sessionId);
      if (!session) throw new SessionOperationError("not_found", store.missingSessionMessage());
      const approve = this.options.approve?.(operation);
      runtime = await (this.options.attach ?? attachSessionRuntime)({ store, session, operation, owner,
        signal: active.controller.signal, ...(this.options.processes ? { processes: this.options.processes } : {}), ...(this.options.interactions ? { interactions: this.options.interactions } : {}), ...(approve ? { approve } : {}), ...(this.options.env ? { env: this.options.env } : {}),
        ...(active.request && operation.kind === "turn" ? { request: active.request } : {}) });
      active.agent = runtime.agent;
      firstRequest = runtime.agent.stats().requests;
      const attached = runtime;
      const measure = (options: MeasureOptions) => attached.measure ? attached.measure(options)
        : measureSession(attached.agent, attached.modelConfig!, options);
      active.measure = () => ({ ...measure({ startedAt, firstRequest, startedTools, failedTools,
        ...(attached.compact ? { compact: attached.compact } : {}) }), historyWatermark: store.historyWatermark(operation.sessionId),
        ...(attached.capabilities ? { capabilities: attached.capabilities } : {}) });
      if (active.controller.signal.aborted) throw new Error("operation cancelled");
      publishState(operation.kind === "compact" ? "compacting" : "running");
      if (operation.kind === "turn") {
        result = await runtime.agent.run(active.blocks ?? operation.input!, event); state = result.status;
      } else if (operation.kind === "panel_action") {
        const run = await runtime.agent.runPanelAction(operation.action!, event);
        result = run; state = run.status;
        if (run.status === "error") error = { code: run.code ?? "action_error", message: run.message ?? "the action failed" };
      } else {
        result = await runtime.agent.compact(runtime.compactOptions ?? {}, event);
        state = result.status === "cancelled" ? "cancelled" : "completed";
      }
    } catch (cause) {
      state = active.controller.signal.aborted ? "cancelled" : "error";
      if (state === "error") error = { code: cause instanceof SessionOperationError ? cause.code : "operation_error",
        message: cause instanceof Error ? cause.message : String(cause) };
    }
    try {
      if (runtime) {
        // The host retains the fenced lease until both tool and agent cleanup complete.
        try { await runtime.close(); } finally { await runtime.agent.close(); }
        metrics = active.measure?.();
      }
    } catch (cause) {
      state = "error"; error = { code: "cleanup_error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    const details = { ...(result ? { result } : {}), ...(error ? { error } : {}), ...(metrics ? { metrics } : {}) };
    // The interrupting message starts the next turn whatever the ending; otherwise a completed turn hands the session to
    // the oldest waiting message, and any other ending, or a Stop that arrived during cleanup, pauses them all.
    let pauseReason: string | undefined;
    const waiting = this.closed ? [] : store.queuedInputs(operation.sessionId).filter((item) => item.state === "queued");
    const next = waiting.find((item) => item.mode === "interrupt")
      ?? (state === "completed" && !active.controller.signal.aborted ? waiting[0] : undefined);
    if (next) {
      try {
        const handed = store.handOff({ id: operation.id, owner, state, details }, next.id);
        this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: handed.previous });
        this.launch(handed.operation, handed.owner, typeof handed.input === "string" ? undefined : handed.input, handed.request);
        this.publishInputs(operation.sessionId, handed.operation.id);
        return handed.previous;
      } catch (cause) { pauseReason = `The next turn could not start: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
    try {
      const terminal = store.updateOperation(operation.id, owner, state, details, pauseReason);
      store.releaseSession(operation.sessionId, owner);
      this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: terminal });
      if (store.queuedInputs(operation.sessionId).length) this.publishInputs(operation.sessionId, operation.id);
      return terminal;
    } catch (cause) {
      this.publish({ type: "host_error", sessionId: operation.sessionId, operationId: operation.id, message: String(cause) });
      throw cause;
    } finally { store.releaseSession(operation.sessionId, owner); }
  }

  async wait(operationId: string): Promise<SessionOperation> {
    const active = this.active.get(operationId);
    if (active) return active.done;
    this.options.store.recoverOperations();
    const operation = this.options.store.getOperation(operationId);
    if (!operation) throw new SessionOperationError("not_found", "operation not found");
    if (!terminalOperationStates.has(operation.state)) throw new SessionOperationError("busy", "operation is owned elsewhere");
    return operation;
  }
  cancel(operationId: string): boolean {
    const active = this.active.get(operationId);
    if (!active) return false;
    active.controller.abort(); active.agent?.abort(); return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
    this.observers.clear();
  }
}
