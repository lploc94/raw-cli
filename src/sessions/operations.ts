import type { AgentSession, RunEvent, RunResult } from "../agent.js";
import type { CompactOptions, CompactResult } from "../compact.js";
import type { CompactSettings } from "../config.js";
import type { ResolvedModelConfig } from "../llm/types.js";
import type { RequestOverride } from "../request-controls.js";
import type { ToolContext } from "../tools/primitives.js";
import type { UserInput } from "../llm/types.js";
import { measureSession, type SessionMetrics } from "./metrics.js";
import { SessionOperationError, terminalOperationStates, type OperationIntent, type OperationState, type SessionOperation } from "./operation-types.js";
import { attachSessionRuntime } from "./runtime.js";
import type { SessionOwner, SessionStore, SessionSummary } from "./store.js";

export type { OperationIntent, OperationState, SessionOperation } from "./operation-types.js";
export { SessionOperationError } from "./operation-types.js";

export interface SessionRuntime {
  capabilities?: SessionMetrics["capabilities"];
  agent: AgentSession;
  modelConfig: Readonly<ResolvedModelConfig>;
  compactOptions: CompactOptions;
  compact?: Readonly<CompactSettings>;
  close(): Promise<void>;
}
export type AttachSessionRuntime = (options: {
  store: SessionStore; session: SessionSummary; operation: SessionOperation; owner: SessionOwner;
  signal: AbortSignal; approve?: ToolContext["approve"]; env?: NodeJS.ProcessEnv;
  /** Per-turn request override, applied to this operation's provider request only. */
  request?: RequestOverride;
}) => Promise<SessionRuntime>;

export type OperationEvent = { sessionId: string; operationId: string } & (
  | { type: "operation"; operation: SessionOperation }
  | { type: "event"; event: RunEvent }
  | { type: "host_error"; message: string }
);
interface ActiveOperation {
  /** Structured turn input for this process only; the persisted operation keeps the text. */
  blocks?: UserInput;
  /** Per-turn request override for this process only; never persisted. */
  request?: RequestOverride;
  controller: AbortController;
  done: Promise<SessionOperation>;
  agent?: AgentSession;
  measure?: () => SessionMetrics;
}

export class SessionOperations {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly observers = new Set<(event: OperationEvent) => void>();
  private closed = false;
  constructor(private readonly options: {
    store: SessionStore; attach?: AttachSessionRuntime; env?: NodeJS.ProcessEnv;
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
  approvalTimeout(operationId: string): number { return this.active.get(operationId)?.agent?.requestTimeoutMs ?? 120000; }
  toolIdentity(operationId: string, name: string): string | undefined { return this.active.get(operationId)?.agent?.toolIdentity(name); }

  submit(intent: OperationIntent, blocks?: UserInput, request?: RequestOverride): SessionOperation {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    const { operation, owner } = this.options.store.acceptOperation(intent);
    if (!owner) return operation;
    const controller = new AbortController();
    let resolveDone!: (operation: SessionOperation) => void;
    let rejectDone!: (error: unknown) => void;
    const active: ActiveOperation = { ...(blocks ? { blocks } : {}), ...(request ? { request } : {}), controller, done: new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }) };
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
    return structuredClone(operation);
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
        signal: active.controller.signal, ...(approve ? { approve } : {}), ...(this.options.env ? { env: this.options.env } : {}),
        ...(active.request && operation.kind === "turn" ? { request: active.request } : {}) });
      active.agent = runtime.agent;
      firstRequest = runtime.agent.stats().requests;
      const attached = runtime;
      active.measure = () => ({ ...measureSession(attached.agent, attached.modelConfig, { startedAt, firstRequest, startedTools, failedTools,
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
        result = await runtime.agent.compact(runtime.compactOptions, event);
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
    try {
      const terminal = store.updateOperation(operation.id, owner, state, {
        ...(result ? { result } : {}), ...(error ? { error } : {}), ...(metrics ? { metrics } : {}),
      });
      store.releaseSession(operation.sessionId, owner);
      this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: terminal });
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
