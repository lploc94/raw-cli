import { randomUUID } from "node:crypto";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { InteractionService } from "../interactions/service.js";
import type { RunEvent, RunResult } from "../agent.js";
import type { AcpBackendProvider } from "../backends/acp-agent.js";
import type { BackgroundEvent, CliTask, SessionAgent } from "../backends/types.js";
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
  /** A backend CLI's provider, and how to keep it past the operation while its background work runs (cli-background-work). */
  backend?: { provider: AcpBackendProvider; detach(): Promise<AcpBackendProvider | undefined> };
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
  /** The session's kept backend provider, and notices for its next turn (cli-background-work). */
  resident?: AcpBackendProvider;
  notices?: readonly string[];
  /** Keeps notices for the session's next operation until this one delivers them (an attach that fails keeps them). */
  carry?: (notices: readonly string[]) => void;
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

/**
 * A session's backend provider that this process keeps (cli-background-work, Design "Residency"): attached while an
 * operation runs on it, parked between operations while its CLI has background work. Parked, it holds no lease.
 */
interface Resident {
  provider: AcpBackendProvider;
  attached: boolean;
  /** The agent and config of the operation that last ran on it, for the CLI turns it starts. */
  agentName: string;
  configPath: string;
  unsubscribe: () => void;
}

export class SessionOperations {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly residents = new Map<string, Resident>();
  /** Notices of a closed provider (an exit, an abandoned turn) for the session's next operation. */
  private readonly carried = new Map<string, string[]>();
  /** Providers being closed, no longer residents. */
  private readonly closing = new Set<Promise<void>>();
  /** Sessions whose CLI turn waits for this process's running operation to end. */
  private readonly cliPending = new Set<string>();
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
    let cliRan = false;
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
      const resident = this.residents.get(operation.sessionId);
      const carried = this.carried.get(operation.sessionId);
      runtime = await (this.options.attach ?? attachSessionRuntime)({ store, session, operation, owner,
        ...(resident && !resident.provider.isClosed ? { resident: resident.provider } : {}), ...(carried ? { notices: carried } : {}),
        carry: (notices) => this.carry(operation.sessionId, notices),
        signal: active.controller.signal, ...(this.options.processes ? { processes: this.options.processes } : {}), ...(this.options.interactions ? { interactions: this.options.interactions } : {}), ...(approve ? { approve } : {}), ...(this.options.env ? { env: this.options.env } : {}),
        ...(active.request && operation.kind === "turn" ? { request: active.request } : {}) });
      active.agent = runtime.agent;
      this.carried.delete(operation.sessionId);
      if (runtime.backend) this.attachResident(operation, runtime.backend.provider);
      // Raw's own loop stopped the kept adapter it replaced.
      else if (resident?.provider.isClosed) this.dropResident(operation.sessionId, resident.provider);
      firstRequest = runtime.agent.stats().requests;
      const attached = runtime;
      const measure = (options: MeasureOptions) => attached.measure ? attached.measure(options)
        : measureSession(attached.agent, attached.modelConfig!, options);
      active.measure = () => ({ ...measure({ startedAt, firstRequest, startedTools, failedTools,
        ...(attached.compact ? { compact: attached.compact } : {}) }), historyWatermark: store.historyWatermark(operation.sessionId),
        ...(attached.capabilities ? { capabilities: attached.capabilities } : {}) });
      if (active.controller.signal.aborted) throw new Error("operation cancelled");
      publishState(operation.kind === "compact" ? "compacting" : "running");
      if (operation.kind === "turn" && operation.origin === "cli") {
        cliRan = true;
        result = await (runtime.agent.background?.runCliTurn(event) ?? Promise.resolve<RunResult>({ status: "completed", steps: 0, text: "" }));
        state = result.status;
      } else if (operation.kind === "turn") {
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
    // A CLI turn that ended before it ran (attach error, Stop during startup): Claude Code's own turn is stopped with a
    // notice, and Codex's completions stay owed.
    const backend = runtime?.backend?.provider ?? this.residents.get(operation.sessionId)?.provider;
    if (operation.origin === "cli" && !cliRan && backend && !backend.isClosed) await backend.abandonCliTurn();
    try {
      if (runtime) {
        // The host retains the fenced lease until both tool and agent cleanup complete.
        try { await runtime.close(); } finally {
          // A CLI with background work keeps its adapter, parked until the next operation (cli-background-work).
          const kept = await runtime.backend?.detach();
          if (kept) this.park(operation.sessionId, kept);
          else {
            if (runtime.backend) this.dropResident(operation.sessionId, runtime.backend.provider);
            await runtime.agent.close();
          }
        }
        metrics = active.measure?.();
      } else if (backend) {
        // The attach failed: a provider it took is parked again, or closed once its work is gone.
        backend.rebind(undefined);
        this.park(operation.sessionId, backend);
      }
    } catch (cause) {
      state = "error"; error = { code: "cleanup_error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    const details = { ...(result ? { result } : {}), ...(error ? { error } : {}), ...(metrics ? { metrics } : {}) };
    // The interrupting message starts the next turn whatever the ending; otherwise a completed turn hands the session to
    // the oldest waiting message, and any other ending, or a Stop that arrived during cleanup, pauses them all.
    let pauseReason: string | undefined;
    const waiting = this.closed ? [] : store.queuedInputs(operation.sessionId).filter((item) => item.state === "queued");
    const interrupt = waiting.find((item) => item.mode === "interrupt");
    // A CLI turn waiting for this operation runs next, after an interrupting message and before the queued ones.
    const cliIntent = !interrupt && !this.closed && this.cliPending.delete(operation.sessionId) ? this.cliIntent(operation.sessionId) : undefined;
    if (cliIntent) {
      try {
        const handed = store.handOffTo({ id: operation.id, owner, state, details }, cliIntent);
        this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: handed.previous });
        this.launch(handed.operation, handed.owner);
        return handed.previous;
      } catch (cause) {
        // The session is released below; the CLI turn is then submitted as on an idle session.
        this.publish({ type: "host_error", sessionId: operation.sessionId, operationId: operation.id,
          message: `The background turn could not start: ${cause instanceof Error ? cause.message : String(cause)}` });
        this.cliPending.add(operation.sessionId);
      }
    }
    const next = interrupt ?? (!cliIntent && state === "completed" && !active.controller.signal.aborted ? waiting[0] : undefined);
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
    } finally {
      store.releaseSession(operation.sessionId, owner);
      if (this.cliPending.delete(operation.sessionId)) setImmediate(() => this.cliTurn(operation.sessionId));
    }
  }

  /** Tracks the provider an operation runs on: the session's resident from now on, attached until the operation ends. */
  private attachResident(operation: SessionOperation, provider: AcpBackendProvider): void {
    const known = this.residents.get(operation.sessionId);
    if (known?.provider === provider) { Object.assign(known, { attached: true, agentName: operation.agentName, configPath: operation.configPath }); return; }
    known?.unsubscribe();
    this.residents.set(operation.sessionId, { provider, attached: true, agentName: operation.agentName, configPath: operation.configPath,
      unsubscribe: provider.onBackground((event) => this.background(operation.sessionId, provider, event)) });
  }

  /** Parks a provider between operations; one without background work left is closed instead. */
  private park(sessionId: string, provider: AcpBackendProvider): void {
    const resident = this.residents.get(sessionId);
    if (resident?.provider !== provider) { void this.closeProvider(sessionId, provider); return; }
    resident.attached = false;
    if (this.closed) { void this.closeResident(sessionId); return; }
    this.closeIfIdle(sessionId);
  }

  /** A parked provider whose CLI has nothing left (no task, turn, owed completion or fallback watch) is closed. */
  private closeIfIdle(sessionId: string): void {
    const resident = this.residents.get(sessionId);
    if (resident && !resident.attached && !resident.provider.keepsAdapter()) void this.closeResident(sessionId);
  }

  /** Forgets the session's resident provider, which its operation closes itself. */
  private dropResident(sessionId: string, provider: AcpBackendProvider): void {
    const resident = this.residents.get(sessionId);
    if (resident?.provider !== provider) return;
    resident.unsubscribe();
    this.residents.delete(sessionId);
    this.carry(sessionId, provider.drainNotices());
  }

  private async closeResident(sessionId: string): Promise<void> {
    const resident = this.residents.get(sessionId);
    if (!resident) return;
    resident.unsubscribe();
    this.residents.delete(sessionId);
    await this.closeProvider(sessionId, resident.provider);
  }

  /** Closes a provider; `close()` of this service waits for every close still under way. */
  private closeProvider(sessionId: string, provider: AcpBackendProvider): Promise<void> {
    this.carry(sessionId, provider.drainNotices());
    const closing: Promise<void> = provider.close().catch(() => {}).finally(() => { this.closing.delete(closing); });
    this.closing.add(closing);
    return closing;
  }

  private carry(sessionId: string, notices: readonly string[]): void {
    if (notices.length) this.carried.set(sessionId, [...(this.carried.get(sessionId) ?? []), ...notices]);
  }

  /** What a session's resident provider reports between and during operations. */
  private background(sessionId: string, provider: AcpBackendProvider, event: BackgroundEvent): void {
    if (this.residents.get(sessionId)?.provider !== provider) return;
    if (event.type === "cli_turn") this.cliTurn(sessionId);
    else if (event.type === "tasks") { this.listTasks(sessionId, provider, event.tasks); this.closeIfIdle(sessionId); }
    else if (event.type === "exited") {
      // The adapter is gone with its work: the next operation starts a fresh one and is told what was lost.
      this.listTasks(sessionId, provider, provider.backgroundTasks());
      const resident = this.residents.get(sessionId)!;
      resident.unsubscribe();
      this.residents.delete(sessionId);
      this.carry(sessionId, provider.drainNotices());
      if (event.lost.length) this.carry(sessionId, [`${provider.label} exited; ${event.lost.length} background task(s) were lost: ${event.lost.join(", ")}`]);
      if (!resident.attached) void this.closeProvider(sessionId, provider);
    }
  }

  /** The CLI's tasks as rows of the session's Commands tab. */
  private listTasks(sessionId: string, provider: AcpBackendProvider, tasks: readonly CliTask[]): void {
    const commands = this.options.processes?.commands;
    const cwd = commands && this.options.store.getSession(sessionId)?.cwd;
    if (!commands || cwd === undefined) return;
    const rows = commands.cli(sessionId, cwd, provider.kind === "claude" ? "cli/claude-code" : "cli/codex");
    for (const task of tasks) {
      try { rows.upsert(task); } catch { /* the listing does not own the CLI's work */ }
    }
  }

  /** The operation a session's waiting CLI turn runs as, if one waits. */
  private cliIntent(sessionId: string): OperationIntent | undefined {
    const resident = this.residents.get(sessionId);
    const note = resident && !resident.provider.isClosed ? resident.provider.cliTurnNote() : undefined;
    if (!resident || note === undefined) return undefined;
    return { sessionId, clientRequestId: `cli-${randomUUID()}`, kind: "turn", origin: "cli", agentName: resident.agentName,
      configPath: resident.configPath, input: note };
  }

  /**
   * The CLI has a turn to take (Design, "Starting a CLI turn"): it starts now on an idle session, after the running
   * operation of this process, and with the session held elsewhere Claude Code's turn is stopped while Codex's
   * completions wait for this process's next turn, each with a notice.
   */
  private cliTurn(sessionId: string): void {
    if (this.closed) return;
    if (this.holder(sessionId)) { this.cliPending.add(sessionId); return; }
    const intent = this.cliIntent(sessionId);
    if (!intent) return;
    const provider = this.residents.get(sessionId)!.provider;
    try { this.submit(intent); }
    catch (cause) {
      const elsewhere = cause instanceof SessionOperationError && cause.code === "busy";
      void (async () => {
        if (provider.ownTurnPending) await provider.abandonCliTurn(elsewhere ? "the session was in use elsewhere" : `Raw could not record it (${cause instanceof Error ? cause.message : String(cause)})`);
        else provider.noticeNextTurn([elsewhere ? `${provider.label} finished a background task while the session was in use elsewhere`
          : `${provider.label} finished a background task, but Raw could not start its turn: ${cause instanceof Error ? cause.message : String(cause)}`]);
        this.closeIfIdle(sessionId);
      })();
    }
  }

  /** Stops one background task of the session's CLI; false when it has none by that id or cannot stop it. */
  async stopCliTask(sessionId: string, taskId: string): Promise<boolean> {
    return await this.residents.get(sessionId)?.provider.stopTask(taskId) ?? false;
  }

  /** The session is deleted: its CLI's tasks are stopped and its kept adapter closed. */
  async forgetSession(sessionId: string): Promise<void> {
    this.cliPending.delete(sessionId);
    this.carried.delete(sessionId);
    const resident = this.residents.get(sessionId);
    if (!resident) return;
    const live = resident.provider.backgroundTasks().filter((task) => task.state === "running" || task.state === "paused");
    await Promise.all(live.map((task) => resident.provider.stopTask(task.id)));
    await this.closeResident(sessionId);
    this.carried.delete(sessionId);
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
    // Kept adapters stop with the dashboard, and their tasks with them.
    await Promise.allSettled([...this.residents.keys()].map((sessionId) => this.closeResident(sessionId)));
    await Promise.allSettled([...this.closing]);
    this.observers.clear();
  }
}
