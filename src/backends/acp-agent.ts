import { createHash } from "node:crypto";
import { client, PROTOCOL_VERSION, type AnyMessage, type ClientConnection, type ContentBlock, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionConfigOption, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentState, RunEvent, RunResult } from "../agent.js";
import type { CompactResult } from "../compact.js";
import type { UsageSummary } from "../llm/cache.js";
import { imagePlaceholderText, type ExternalTurnEvent, type ModelMessage, type ProviderAdapter, type ProviderRequest, type ProviderTurn,
  type ResolvedModelConfig, type UserInput } from "../llm/types.js";
import { MAX_FRAME_BYTES } from "../acp/transport.js";
import { spawnAcpPeer, type AcpPeer } from "../acp/peer.js";
import type { ExternalSession, SessionOwner, SessionStore } from "../sessions/store.js";
import type { MeasureOptions, SessionMetrics } from "../sessions/metrics.js";
import type { ToolDisplay } from "../tools/display.js";
import type { ToolApprovalRequest } from "../tools/primitives.js";
import { AcpUpdateMapper, cliToolIdentity, KNOWN_UPDATE_KINDS, type AcpTurnEvent } from "./acp-events.js";
import { BACKEND_LABELS, type BackendKind, type BackendSpec } from "./config.js";
import type { PanelActionRequest, SessionAgent } from "./types.js";

/** How to start one ACP agent process and what its `session/new` carries; built per backend kind (claude.ts, codex.ts). */
export interface AcpLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** `_meta` of `session/new` and `session/load` (Claude's `systemPrompt`). */
  sessionMeta?: Record<string, unknown>;
}

/** Values chosen for one CLI conversation or one turn; each is passed through as the CLI names it. */
export interface BackendOptions { model?: string; effort?: string; mode?: string }

/** A run failure with the code a turn ends with (`backend_exited`, `backend_start_timeout`, …). */
export class BackendError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BackendError"; }
}

/** How long a cancelled prompt may take to answer before the tree is stopped (Raw's ACP server answers at once, docs/acp.md). */
export const CANCEL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 2000;
/** How long a closed connection waits for the adapter's exit to be reported. */
const EXIT_WAIT_MS = 1000;
/** The ACP `configOptions` category behind each option, in the order they are applied. */
const CATEGORIES = [["model", "model"], ["effort", "thought_level"], ["mode", "mode"]] as const;

/** Digest of what shapes a CLI conversation: a change of any part starts a fresh one instead of `session/load`. */
export function backendProfileDigest(spec: BackendSpec, systemPrompt: string | undefined): string {
  const prompt = createHash("sha256").update(systemPrompt ?? "").digest("hex");
  return createHash("sha256").update(JSON.stringify([spec.kind, spec.executable ?? "", prompt, spec.systemPromptMode])).digest("hex");
}

/** The model config Raw's records keep for a backend session: no provider Raw calls, only who runs it. */
export function backendModelConfig(agentName: string, spec: BackendSpec): ResolvedModelConfig {
  // Images reach the runner, which sends them when the CLI accepts them (`promptCapabilities.image`).
  return { agentName, provider: `backend:${spec.kind}`, method: "acp", model: spec.model ?? "default", vision: true };
}

function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => "group" in item ? item.options.map((choice) => choice.value) : [item.value]);
}

function promptBlocks(input: UserInput, images: boolean): ContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((block): ContentBlock => block.type === "text" ? { type: "text", text: block.text }
    : block.type === "image" ? images ? { type: "image", data: block.data, mimeType: block.mimeType } : { type: "text", text: imagePlaceholderText(block) }
    : { type: "resource_link", uri: block.uri, name: block.name,
      ...(block.title != null ? { title: block.title } : {}), ...(block.description != null ? { description: block.description } : {}),
      ...(block.mimeType != null ? { mimeType: block.mimeType } : {}), ...(block.size != null ? { size: block.size } : {}) });
}

interface Binding { store: SessionStore; sessionId: string; owner: SessionOwner }

export interface AcpBackendProviderOptions {
  agentName: string;
  spec: BackendSpec;
  systemPrompt?: string;
  launch: AcpLaunch;
  cwd: string;
  autoApprove: boolean;
  approve?: (request: ToolApprovalRequest) => boolean | Promise<boolean>;
  /** Where the CLI's own session id is kept; resolved once the session is bound. */
  binding?: () => Binding | undefined;
  /** Diagnostics that are not part of a turn (Invariant 8); stderr by default. */
  diagnostic?: (line: string) => void;
}

interface ActiveTurn {
  request: ProviderRequest;
  mapper: AcpUpdateMapper;
  text: string;
  /** Restarts the inactivity window; called for every message from the CLI. */
  touch(): void;
  /** Stops the inactivity window while Raw waits on a person; `resume` starts a full window again. */
  pause(): void;
  resume(): void;
}

interface Live { peer: AcpPeer; connection: ClientConnection; died: Promise<never>; loadSession: boolean; images: boolean; ready: Promise<void> }

/**
 * Runs one external ACP agent process (and through it the user's CLI) for one session runtime. Raw's `AgentSession`
 * calls it like a model provider: each `generate` sends the new user messages as one `session/prompt` and returns the
 * CLI's answer; the CLI's own tool calls and notices travel through `onExternal`.
 */
export class AcpBackendProvider implements ProviderAdapter {
  readonly modelConfig: Readonly<ResolvedModelConfig>;
  private readonly label: string;
  private readonly profileDigest: string;
  private live: Live | undefined;
  private cliSessionId: string | undefined;
  private baseline: BackendOptions = {};
  private options: SessionConfigOption[] = [];
  private turn: ActiveTurn | undefined;
  private override: BackendOptions | undefined;
  private readonly unknownKinds = new Map<string, number>();
  private closed = false;
  private previous: Promise<void> = Promise.resolve();
  /** `ExternalSession.delivered` of the open CLI conversation. */
  private delivered: number | undefined;
  /** The CLI's latest report of its context: tokens used and the window. */
  context: { used: number; size: number } | undefined;

  constructor(private readonly config: AcpBackendProviderOptions) {
    this.modelConfig = backendModelConfig(config.agentName, config.spec);
    this.label = BACKEND_LABELS[config.spec.kind as BackendKind];
    this.profileDigest = backendProfileDigest(config.spec, config.systemPrompt);
  }

  /** The adapter process of this runtime, while it runs. */
  get pid(): number | undefined { return this.live?.peer.child.pid; }
  /** The session's current `configOptions`, as the CLI last reported them. */
  get configOptions(): readonly SessionConfigOption[] { return structuredClone(this.options); }
  /** The value of one option category now, or the baseline before the CLI conversation exists. */
  currentValue(key: keyof BackendOptions): string | undefined {
    const category = CATEGORIES.find(([name]) => name === key)![1];
    const option = this.options.find((item) => item.category === category && item.type === "select");
    return option && typeof option.currentValue === "string" ? option.currentValue : this.baseline[key];
  }

  /** Values for the next turn only; the turn after it returns to the session's baseline. */
  setTurnOverride(options: BackendOptions | undefined): void { this.override = options; }

  /**
   * `AgentSession` ends a cancelled turn without waiting for its provider, so a turn starts only once the previous one
   * has stopped its adapter; otherwise it would prompt the process that is being stopped.
   */
  generate(request: ProviderRequest): Promise<ProviderTurn> {
    const turn = this.previous.then(() => this.runTurn(request));
    this.previous = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private async runTurn(request: ProviderRequest): Promise<ProviderTurn> {
    if (this.closed) throw new BackendError("backend_closed", `${this.label} runtime is closed`);
    let lastAnswer = request.messages.length - 1;
    while (lastAnswer >= 0 && request.messages[lastAnswer]!.role !== "assistant") lastAnswer--;
    const notify = (message: string) => request.onExternal?.({ type: "notice", message });
    const override = this.override;
    this.override = undefined;
    await this.startup(request, async (live) => {
      await this.open(live, notify, lastAnswer >= 0);
      const desired: BackendOptions = {};
      for (const [key] of CATEGORIES) {
        const value = override?.[key] ?? this.baseline[key];
        if (value !== undefined) desired[key] = value;
      }
      await this.apply(live, desired, notify);
    });
    // The CLI already has what an earlier turn sent, also when that turn was cancelled before it answered.
    const delivered = this.delivered !== undefined && this.delivered <= request.messages.length ? this.delivered : 0;
    const fresh = request.messages.slice(Math.max(lastAnswer + 1, delivered))
      .filter((message): message is Extract<ModelMessage, { role: "user" }> => message.role === "user");
    if (!fresh.length) throw new BackendError("backend_error", "there is no new message to send");
    const images = this.live!.images;
    if (!images && fresh.some((message) => typeof message.content !== "string" && message.content.some((block) => block.type === "image"))) {
      notify(`${this.label} does not accept images; each is sent as a short description`);
    }
    const prompt = fresh.flatMap((message, index) => [...(index ? [{ type: "text", text: "\n\n" } as ContentBlock] : []), ...promptBlocks(message.content, images)]);
    return this.prompt(this.live!, prompt, request);
  }

  /** Spawns the adapter if needed and runs `work` under the startup deadline (`request_timeout_ms`), abort and crash. */
  private async startup(request: ProviderRequest, work: (live: Live) => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const limits = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BackendError("backend_start_timeout",
        `${this.label} did not start within ${request.timeoutMs} ms`)), request.timeoutMs);
      onAbort = () => reject(new BackendError("aborted", "startup aborted"));
      if (request.signal?.aborted) onAbort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    let current: Live | undefined;
    try {
      await Promise.race([(async () => {
        current = this.live ?? this.spawn();
        await Promise.race([this.exitFirst(current, current.ready.then(() => work(current!))), current.died]);
      })(), limits]);
    } catch (error) {
      // A startup that did not finish leaves no process and no half-open conversation behind.
      this.cliSessionId = undefined;
      if (current) await this.stopPeer(current);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private spawn(): Live {
    const { launch, cwd } = this.config;
    let peer: AcpPeer;
    try { peer = spawnAcpPeer({ command: launch.command, args: launch.args, cwd, env: launch.env, maxFrameBytes: MAX_FRAME_BYTES }); }
    catch (error) { throw this.unavailable(error); }
    const app = client({ name: "raw-cli" });
    app.onNotification("session/update", (params: unknown) => params as SessionNotification, ({ params }) => this.update(params));
    app.onRequest("session/request_permission", (params: unknown) => params as RequestPermissionRequest,
      ({ params }) => this.permission(params));
    // Unknown update kinds never reach the SDK, which would reject them before any handler (Invariant 8).
    const connection = app.connect({ writable: peer.stream.writable, readable: peer.stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({ transform: (message, controller) => {
        const update = (message as { method?: unknown; params?: { update?: { sessionUpdate?: unknown } } });
        const kind = update.method === "session/update" ? update.params?.update?.sessionUpdate : undefined;
        if (typeof kind === "string" && !KNOWN_UPDATE_KINDS.has(kind)) { this.reportUnknown(kind); return; }
        controller.enqueue(message);
      } })) });
    const died = new Promise<never>((_resolve, reject) => {
      peer.child.once("exit", (code, signal) => {
        const tail = peer.stderrTail().trim();
        reject(new BackendError("backend_exited", `${this.label} exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
      });
      peer.spawnFailure.catch((error: unknown) => reject(this.unavailable(error)));
      peer.frameFailure.catch(() => reject(new BackendError("backend_frame_too_large",
        `${this.label} sent a message longer than ${MAX_FRAME_BYTES} bytes`)));
    });
    const live: Live = { peer, connection, died, loadSession: false, images: false, ready: Promise.resolve() };
    died.catch(() => { if (this.live === live) { this.live = undefined; this.cliSessionId = undefined; } });
    live.ready = connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      .then((initialize) => {
        live.loadSession = initialize.agentCapabilities?.loadSession === true;
        live.images = initialize.agentCapabilities?.promptCapabilities?.image === true;
      });
    live.ready.catch(() => {});
    this.live = live;
    return live;
  }

  /**
   * A dying adapter closes the connection before its exit is reported, so a request it leaves unanswered fails with the
   * SDK's transport error; that turn ends with the exit (code and stderr) instead. A JSON-RPC error answer, which has a
   * numeric code, passes through at once.
   */
  private exitFirst<T>(live: Live, work: Promise<T>): Promise<T> {
    return work.catch(async (error: unknown) => {
      const answered = typeof (error as { code?: unknown } | null)?.code === "number";
      if (!answered && await live.peer.waitForExit(EXIT_WAIT_MS)) await live.died;
      throw error;
    });
  }

  private unavailable(error: unknown): BackendError {
    const message = error instanceof Error ? error.message : String(error);
    return new BackendError("backend_unavailable", `${this.label} could not start: ${message}`);
  }

  /** Continues the stored CLI conversation when it is the same profile and the CLI can load it; otherwise starts one. */
  private async open(live: Live, notify: (message: string) => void, hadTurns: boolean): Promise<void> {
    if (this.cliSessionId) return;
    const binding = this.config.binding?.();
    const stored = binding?.store.readExternal(binding.sessionId, binding.owner);
    const meta = this.config.launch.sessionMeta ? { _meta: this.config.launch.sessionMeta } : {};
    if (stored && stored.kind === this.config.spec.kind && stored.profileDigest === this.profileDigest && live.loadSession) {
      try {
        // Updates that replay the conversation arrive before this answer; with no active turn they are not recorded again.
        const loaded = await live.connection.agent.request("session/load", { sessionId: stored.cliSessionId, cwd: this.config.cwd,
          mcpServers: [], ...meta });
        this.options = loaded.configOptions ?? [];
        this.cliSessionId = stored.cliSessionId;
        this.baseline = { ...stored.baseline };
        this.delivered = stored.delivered;
        return;
      } catch (error) {
        // A CLI that no longer has the conversation starts a new one; a CLI that died ends the startup.
        if (live.peer.exited()) throw error;
      }
    }
    const created = await live.connection.agent.request("session/new", { cwd: this.config.cwd, mcpServers: [], ...meta });
    this.cliSessionId = created.sessionId;
    this.options = created.configOptions ?? [];
    const { model, effort, mode } = this.config.spec;
    await this.apply(live, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) }, notify);
    // The baseline is what the conversation runs with once configured, including defaults the CLI chose for that model.
    const baseline: BackendOptions = {};
    for (const [key, category] of CATEGORIES) {
      const option = this.options.find((item) => item.category === category && item.type === "select");
      if (option && typeof option.currentValue === "string") baseline[key] = option.currentValue;
    }
    this.baseline = baseline;
    this.delivered = undefined;
    const external: ExternalSession = { kind: this.config.spec.kind, cliSessionId: created.sessionId, profileDigest: this.profileDigest, baseline };
    if (binding) binding.store.writeExternal(binding.sessionId, binding.owner, external);
    if (hadTurns || stored) notify(`This ${this.label} conversation starts here; it does not see earlier turns`);
  }

  /** Sets model, effort and mode in that order, each checked against the options the CLI lists at that moment. */
  private async apply(live: Live, desired: BackendOptions, notify: (message: string) => void): Promise<void> {
    for (const [key, category] of CATEGORIES) {
      const value = desired[key];
      if (value === undefined) continue;
      const option = this.options.find((item) => item.category === category && item.type === "select");
      if (!option) { notify(`${this.label} has no ${key} option; ${key} "${value}" is not applied`); continue; }
      const values = selectValues(option);
      if (!values.includes(value)) {
        notify(`${this.label} does not offer ${key} "${value}"; it keeps "${String(option.currentValue)}" (offered: ${values.join(", ")})`);
        continue;
      }
      if (option.currentValue === value) continue;
      const response = await live.connection.agent.request("session/set_config_option", { sessionId: this.cliSessionId!, configId: option.id, value });
      this.options = response.configOptions;
    }
  }

  private async prompt(live: Live, prompt: ContentBlock[], request: ProviderRequest): Promise<ProviderTurn> {
    // Recorded before sending, so a store failure ends the turn before the CLI has it.
    const sessionId = this.cliSessionId!;
    this.delivered = request.messages.length;
    const binding = this.config.binding?.();
    const stored = binding?.store.readExternal(binding.sessionId, binding.owner);
    if (binding && stored?.cliSessionId === sessionId) binding.store.writeExternal(binding.sessionId, binding.owner, { ...stored, delivered: this.delivered });
    let rejectIdle!: (error: Error) => void;
    const idle = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
    let timer: NodeJS.Timeout | undefined;
    let paused = 0;
    const arm = () => {
      clearTimeout(timer);
      if (paused) return;
      timer = setTimeout(() => { detach("backend_error", `${this.label} sent nothing for ${request.timeoutMs} ms`);
        rejectIdle(new BackendError("backend_unresponsive", `${this.label} sent nothing for ${request.timeoutMs} ms`)); }, request.timeoutMs);
    };
    // A cancelled or silent turn ends now: its open calls get their result before the loop records the run's end, and
    // whatever the CLI sends while it is being stopped is not part of the turn.
    const detach = (code: string, message: string) => {
      if (this.turn !== turn) return;
      for (const event of turn.mapper.closeOpen(code, message)) this.dispatch(turn, event);
      this.turn = undefined;
    };
    const turn: ActiveTurn = { request, mapper: new AcpUpdateMapper(), text: "", touch: arm,
      pause: () => { paused++; clearTimeout(timer); }, resume: () => { paused = Math.max(0, paused - 1); arm(); } };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { detach("cancelled", "cancelled"); reject(new BackendError("aborted", "turn cancelled")); };
      if (request.signal?.aborted) onAbort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.turn = turn;
    arm();
    const response = this.exitFirst(live, live.connection.agent.request("session/prompt", { sessionId, prompt }));
    response.catch(() => {});
    try {
      const answer = await Promise.race([response, idle, aborted, live.died]);
      for (const event of turn.mapper.closeOpen("backend_error", `${this.label} did not report a result for this call`)) this.dispatch(turn, event);
      return { text: turn.text, toolCalls: [], finishReason: answer.stopReason, ...(answer.usage ? { usage: answer.usage } : {}) };
    } catch (error) {
      const cancelled = error instanceof BackendError && error.code === "aborted";
      if (cancelled || (error instanceof BackendError && error.code === "backend_unresponsive")) {
        // The CLI is asked to stop first so it can save its conversation, then the whole tree goes (Invariant 7);
        // the next turn starts a new adapter and loads the conversation.
        void live.connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([response.then(() => undefined, () => undefined), live.died.catch(() => undefined),
          new Promise<void>((resolve) => { grace = setTimeout(resolve, CANCEL_GRACE_MS); })]);
        clearTimeout(grace);
      }
      detach("backend_error", (error as Error).message);
      await this.stopPeer(live);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  private update(notification: SessionNotification): void {
    const turn = this.turn;
    if (notification.sessionId !== this.cliSessionId) return;
    if (!turn) {
      // Outside a turn (a `session/load` replay, a late update) nothing is recorded: Raw already has that history.
      // Session state still changes: the options and the context the CLI reports.
      const { update } = notification;
      if (update.sessionUpdate === "config_option_update") this.options = update.configOptions;
      else if (update.sessionUpdate === "usage_update") this.context = { used: update.used, size: update.size };
      return;
    }
    turn.touch();
    for (const event of turn.mapper.map(notification.update)) this.dispatch(turn, event);
  }

  private dispatch(turn: ActiveTurn, event: AcpTurnEvent): void {
    const { request } = turn;
    if (event.type === "text") { turn.text += event.text; request.onTextDelta?.(event.text); }
    else if (event.type === "reasoning") request.onReasoningDelta?.(event.text);
    else if (event.type === "context") this.context = { used: event.used, size: event.size };
    else if (event.type === "config") this.options = event.options;
    else if (event.type === "unknown") this.reportUnknown(event.kind);
    else request.onExternal?.(event as ExternalTurnEvent);
  }

  /** Counts an update Raw does not handle and reports its kind once per runtime. */
  private reportUnknown(kind: string): void {
    const seen = this.unknownKinds.get(kind) ?? 0;
    this.unknownKinds.set(kind, seen + 1);
    if (!seen) (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} sent unknown update ${kind}\n`);
  }

  /** Count of each unknown update kind this runtime received. */
  get unknownUpdates(): ReadonlyMap<string, number> { return new Map(this.unknownKinds); }

  private async permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.turn;
    const pick = (...kinds: string[]) => kinds.map((kind) => params.options.find((option) => option.kind === kind)).find(Boolean);
    const allow = pick("allow_once", "allow_always");
    const reject = pick("reject_once", "reject_always");
    const choose = (option: typeof allow) => option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" as const } };
    const title = params.toolCall.title ?? "a tool";
    if (!turn || turn.request.signal?.aborted) return choose(reject);
    if (!this.config.approve) {
      if (this.config.autoApprove) return choose(allow);
      turn.request.onExternal?.({ type: "notice", message: `${this.label} asked to run ${title}; no approval channel` });
      return choose(reject);
    }
    const name = params.toolCall.name ?? title;
    const input = params.toolCall.rawInput && typeof params.toolCall.rawInput === "object" && !Array.isArray(params.toolCall.rawInput)
      ? params.toolCall.rawInput as Record<string, unknown> : {};
    turn.pause();
    try {
      const allowed = await this.config.approve({ identity: cliToolIdentity("other", name), name, title, summary: title,
        arguments: input, toolCallId: params.toolCall.toolCallId, ...(turn.request.signal ? { signal: turn.request.signal } : {}) });
      return choose(allowed ? allow : reject);
    } catch { return choose(reject); }
    finally { turn.resume(); }
  }

  private async stopPeer(live: Live): Promise<void> {
    if (this.live === live) { this.live = undefined; this.cliSessionId = undefined; }
    live.connection.close();
    await live.peer.stop(0).catch(() => {});
  }

  /** Stops the adapter and everything it started; the stored CLI session stays, so a reopened session resumes it. */
  async close(): Promise<void> {
    this.closed = true;
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    live.connection.close();
    await live.peer.stop(CLOSE_GRACE_MS);
  }
}

/** Raw's session agent for an ACP backend: Raw's loop owns history and turn state, the provider runs the CLI. */
export class AcpBackendAgent implements SessionAgent {
  constructor(private readonly session: AgentSession, readonly provider: AcpBackendProvider) {}

  get state(): AgentState { return this.session.state; }
  get transcript(): readonly ModelMessage[] { return this.session.transcript; }
  start(source: "create" | "resume", onEvent?: (event: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.session.start(source, onEvent, signal);
  }
  /** Values for the next turn only (Fixed decision 6). */
  setTurnOverride(options: BackendOptions | undefined): void { this.provider.setTurnOverride(options); }
  run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    return this.session.run(input, onEvent).finally(() => this.provider.setTurnOverride(undefined));
  }
  async runPanelAction(_request: PanelActionRequest): Promise<RunResult> {
    return { status: "error", steps: 0, code: "unsupported_backend", message: "panel actions of this backend are not available" };
  }
  compact(): Promise<CompactResult> {
    return Promise.reject(Object.assign(new Error("compaction is not supported by this backend: the CLI keeps its own context"),
      { code: "unsupported_backend" }));
  }
  abort(): boolean { return this.session.abort(); }
  async close(onEvent?: (event: RunEvent) => void): Promise<void> {
    try { await this.session.close(onEvent); } finally { await this.provider.close(); }
  }
  stats(fromRequest?: number): UsageSummary { return this.session.stats(fromRequest); }
  contextUsage(): { tokens: number; source: "provider" | "estimate"; window?: number } {
    const context = this.provider.context;
    return context ? { tokens: context.used, source: "provider", window: context.size } : { tokens: 0, source: "estimate" };
  }
  toolIdentity(name: string): string | undefined { return this.session.toolIdentity(name); }
  toolDisplay(name: string): ToolDisplay | undefined { return this.session.toolDisplay(name); }
}

/** Session metrics of a backend session: the CLI's own context report, no output reserve or compaction trigger. */
export function measureBackend(agent: AcpBackendAgent, agentName: string, options: MeasureOptions): SessionMetrics {
  const { tokens, source, window } = agent.contextUsage();
  return { measuredAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - options.startedAt)),
    model: agent.provider.currentValue("model") ?? agent.provider.modelConfig.model, agentName,
    startedTools: options.startedTools, failedTools: options.failedTools, session: agent.stats(), turn: agent.stats(options.firstRequest),
    context: { estimatedTokens: tokens, source, outputReserve: 0,
      ...(window ? { contextWindow: window, percentage: tokens / window * 100, inputBudget: window } : {}) } };
}
