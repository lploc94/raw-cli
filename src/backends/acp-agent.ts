import { createHash, randomUUID } from "node:crypto";
import { client, PROTOCOL_VERSION, type AnyMessage, type ClientConnection, type ContentBlock, type McpServerStdio, type RequestPermissionRequest,
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
import { AcpUpdateMapper, cliToolIdentity, bridgeToolName, KNOWN_UPDATE_KINDS, type AcpTurnEvent } from "./acp-events.js";
import { bridgeProxyServer } from "./bridge/proxy.js";
import { offeredFromConfigOptions, type BackendOffered } from "./options.js";
import { startBridge, type RawBridge } from "./bridge/server.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { BACKEND_LABELS, type BackendKind, type BackendSpec } from "./config.js";
import type { PanelActionRequest, SessionAgent } from "./types.js";

/** How to start one ACP agent process and what its `session/new` carries; built per backend kind (claude.ts, codex.ts). */
export interface AcpLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** `_meta` of `session/new` and `session/load` (Claude's `systemPrompt`). */
  sessionMeta?: Record<string, unknown>;
  /** What to tell the user when the CLI answers that it needs a login. */
  authHint?: string;
  /** Removes what the launch wrote for this runtime (Codex's prompt file); run once when the runtime closes. */
  cleanup?: () => void;
  /** Restores what the launch wrote, if something removed it, and marks it in use; run before each adapter start. */
  prepare?: () => void;
}

/** Builds the launch when the first turn needs it (installing the adapter on first use); its errors end the turn unavailable. */
export type AcpLaunchResolver = (context: { notify: (message: string) => void; signal?: AbortSignal }) => Promise<AcpLaunch>;

/** ACP's JSON-RPC code for "Authentication required" (`RequestError.authRequired`). */
const AUTH_REQUIRED = -32000;

/** Values chosen for one CLI conversation or one turn; each is passed through as the CLI names it. */
export interface BackendOptions { model?: string; effort?: string; mode?: string }

/** What the session agent and the host need from the provider that runs a backend CLI (ACP, or agy's stream-json). */
export interface BackendProvider extends ProviderAdapter {
  /** The model the CLI reported for the last prompt, when it reports one. */
  readonly usedModel: string | undefined;
  /** The CLI's latest report of its context: tokens used and the window. */
  readonly context: { used: number; size: number } | undefined;
  /** The value of one option now, or the baseline before the CLI conversation exists. */
  currentValue(key: keyof BackendOptions): string | undefined;
  /** Values for the next turn only; the turn after it returns to the session's baseline. */
  setTurnOverride(options: BackendOptions | undefined): void;
  /** Notices the next turn reports first (the host's startup warnings, for a host that shows only turns). */
  noticeNextTurn(messages: readonly string[]): void;
  close(): Promise<void>;
  /** The CLI process running now. */
  readonly pid: number | undefined;
  /** Count of each unknown update kind this runtime received. */
  readonly unknownUpdates: ReadonlyMap<string, number>;
}

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
  launch: AcpLaunch | AcpLaunchResolver;
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

type McpServers = McpServerStdio[];

interface Live { peer: AcpPeer; connection: ClientConnection; died: Promise<never>; loadSession: boolean; images: boolean; ready: Promise<void> }

/**
 * Runs one external ACP agent process (and through it the user's CLI) for one session runtime. Raw's `AgentSession`
 * calls it like a model provider: each `generate` sends the new user messages as one `session/prompt` and returns the
 * CLI's answer; the CLI's own tool calls and notices travel through `onExternal`.
 */
export class AcpBackendProvider implements BackendProvider {
  readonly modelConfig: Readonly<ResolvedModelConfig>;
  private readonly label: string;
  private readonly profileDigest: string;
  private live: Live | undefined;
  private launch: AcpLaunch | undefined;
  private cliSessionId: string | undefined;
  private baseline: BackendOptions = {};
  private options: SessionConfigOption[] = [];
  private turn: ActiveTurn | undefined;
  private override: BackendOptions | undefined;
  private readonly queuedNotices: string[] = [];
  private readonly unknownKinds = new Map<string, number>();
  private closed = false;
  private previous: Promise<void> = Promise.resolve();
  /** `ExternalSession.delivered` of the open CLI conversation. */
  private delivered: number | undefined;
  /** Raw's tools offered to the CLI (the agent's bridged selection), and the bridge serving them once started. */
  private tools: readonly ToolDefinition[] = [];
  private bridge: Promise<RawBridge | undefined> | undefined;
  /** The model the CLI reported for the last prompt (`_meta.quota.model_usage`), when it reports one. */
  usedModel: string | undefined;
  /** The CLI's latest report of its context: tokens used and the window. */
  context: { used: number; size: number } | undefined;

  constructor(private readonly config: AcpBackendProviderOptions) {
    this.modelConfig = backendModelConfig(config.agentName, config.spec);
    this.label = BACKEND_LABELS[config.spec.kind as BackendKind];
    this.profileDigest = backendProfileDigest(config.spec, config.systemPrompt);
  }

  /** The adapter process of this runtime, while it runs. */
  get pid(): number | undefined { return this.live?.peer.child.pid; }
  /**
   * What the CLI offers to a new conversation configured as the agent's, for the dashboard before a session runs: starts
   * the adapter and a throwaway conversation, then stops them. The notices are what applying the agent's values said.
   */
  async discover(timeoutMs: number, signal?: AbortSignal): Promise<{ offered: BackendOffered; notices: string[] }> {
    const notices: string[] = [];
    const notify = (message: string) => { notices.push(message); };
    const request = { system: "", messages: [], tools: [], timeoutMs, ...(signal ? { signal } : {}) } as ProviderRequest;
    try {
      await this.resolveLaunch(request, notify);
      await this.startup(request, (live) => this.open(live, notify, false, []));
      return { offered: offeredFromConfigOptions(this.options), notices };
    } finally { await this.close(); }
  }

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
  noticeNextTurn(messages: readonly string[]): void { this.queuedNotices.push(...messages); }

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
    // A startup the user cancelled has no turn left to report to.
    const notify = (message: string) => { if (!request.signal?.aborted) request.onExternal?.({ type: "notice", message }); };
    if (!request.signal?.aborted) for (const message of this.queuedNotices.splice(0)) notify(message);
    const override = this.override;
    this.override = undefined;
    this.tools = request.tools;
    try { return await this.runPrompt(request, notify, override, lastAnswer); }
    catch (error) {
      // A JSON-RPC error answer from the CLI (numeric code): its details say what went wrong, e.g. that the CLI exited.
      const answer = error as { code?: unknown; message?: string; data?: { details?: unknown } };
      if (typeof answer.code !== "number") throw error;
      if (answer.code === AUTH_REQUIRED) throw new BackendError("backend_auth", `${this.label} needs a login: ${this.launch?.authHint ?? answer.message}`);
      const details = typeof answer.data?.details === "string" ? `: ${answer.data.details}` : "";
      throw new BackendError("backend_error", `${this.label}: ${answer.message ?? "error"}${details}`);
    }
  }

  private async runPrompt(request: ProviderRequest, notify: (message: string) => void, override: BackendOptions | undefined,
    lastAnswer: number): Promise<ProviderTurn> {
    await this.resolveLaunch(request, notify);
    const mcpServers = await this.mcpServers(notify);
    await this.startup(request, async (live) => {
      await this.open(live, notify, lastAnswer >= 0, mcpServers);
      const desired: BackendOptions = {};
      for (const [key] of CATEGORIES) {
        const value = override?.[key] ?? this.baseline[key];
        if (value !== undefined) desired[key] = value;
      }
      await this.apply(live, desired, notify);
    });
    // What the CLI offers after this turn's model is set (Claude's efforts depend on it), for the dashboard.
    this.saveOffered();
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
    const turn = await this.prompt(this.live!, prompt, request);
    // The CLI may change its options while it works (a model switch); the dashboard lists what it offers at the end.
    this.saveOffered();
    return turn;
  }

  /** The launch, built once; building it may install the adapter, which is not bound by the startup deadline. */
  private async resolveLaunch(request: ProviderRequest, notify: (message: string) => void): Promise<void> {
    if (this.launch) return;
    const { launch } = this.config;
    if (typeof launch !== "function") { this.launch = launch; return; }
    if (request.signal?.aborted) throw new BackendError("aborted", "startup aborted");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new BackendError("aborted", "startup aborted"));
      if (request.signal?.aborted) onAbort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const building = launch({ notify, ...(request.signal ? { signal: request.signal } : {}) });
    try {
      this.launch = await Promise.race([building, aborted]);
      // Closed while the launch was being built: what it wrote goes now, since close has already run.
      if (this.closed) { this.cleanupLaunch(); throw new BackendError("aborted", "startup aborted"); }
    } catch (error) {
      // A launch that finishes after its turn was cancelled is not used: what it wrote goes.
      if (!this.launch) void building.then((late) => late.cleanup?.(), () => {});
      if (error instanceof BackendError) throw error;
      throw new BackendError("backend_unavailable", `${this.label} is not available: ${(error as Error).message}`);
    } finally { if (onAbort) request.signal?.removeEventListener("abort", onAbort); }
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
    const { cwd } = this.config;
    const launch = this.launch!;
    let peer: AcpPeer;
    try { launch.prepare?.(); peer = spawnAcpPeer({ command: launch.command, args: launch.args, cwd, env: launch.env, maxFrameBytes: MAX_FRAME_BYTES }); }
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
  private async open(live: Live, notify: (message: string) => void, hadTurns: boolean, mcpServers: McpServers): Promise<void> {
    if (this.cliSessionId) return;
    const binding = this.config.binding?.();
    const stored = binding?.store.readExternal(binding.sessionId, binding.owner);
    const meta = this.launch!.sessionMeta ? { _meta: this.launch!.sessionMeta } : {};
    if (stored && stored.kind === this.config.spec.kind && stored.profileDigest === this.profileDigest && live.loadSession) {
      try {
        // Updates that replay the conversation arrive before this answer; with no active turn they are not recorded again.
        const loaded = await live.connection.agent.request("session/load", { sessionId: stored.cliSessionId, cwd: this.config.cwd,
          mcpServers, ...meta });
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
    const created = await live.connection.agent.request("session/new", { cwd: this.config.cwd, mcpServers, ...meta });
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
    // What an earlier CLI conversation of this session was sent, a cancelled turn's input too, is not sent to this one.
    this.delivered = stored?.delivered ?? this.delivered;
    const external: ExternalSession = { kind: this.config.spec.kind, cliSessionId: created.sessionId, profileDigest: this.profileDigest, baseline,
      ...(this.delivered !== undefined ? { delivered: this.delivered } : {}) };
    if (binding) binding.store.writeExternal(binding.sessionId, binding.owner, external);
    if (hadTurns || stored) notify(`This ${this.label} conversation starts here; it does not see earlier turns`);
  }

  private saveOffered(): void {
    const binding = this.config.binding?.();
    const stored = binding?.store.readExternal(binding.sessionId, binding.owner);
    if (!binding || !stored || stored.cliSessionId !== this.cliSessionId) return;
    // The lists are those of the model in use; the current values are the conversation's own, which a turn returns to.
    const offered = offeredFromConfigOptions(this.options, this.baseline);
    if (JSON.stringify(offered) !== JSON.stringify(stored.offered)) binding.store.writeExternal(binding.sessionId, binding.owner, { ...stored, offered });
  }

  /**
   * The Raw bridge as the CLI's MCP server `raw`, started once per runtime when the agent has bridged tools. A bridge that
   * cannot start leaves the session without Raw's tools and says so (Invariant 5).
   */
  private async mcpServers(notify: (message: string) => void): Promise<McpServers> {
    if (!this.tools.length) return [];
    this.bridge ??= startBridge({ tools: () => this.tools, call: (name, args, signal) => this.bridgeCall(name, args, signal) })
      .catch((error: unknown) => {
        notify(`Raw tools are unavailable in this session: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
    const bridge = await this.bridge;
    return bridge ? [bridgeProxyServer(bridge)] : [];
  }

  /** A bridged tool call from the CLI: run by the active turn; the inactivity watchdog waits while Raw runs it. */
  private async bridgeCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const turn = this.turn;
    if (!turn?.request.runTool) throw new Error("no active turn");
    turn.pause();
    try { return await turn.request.runTool({ id: `bridge-${randomUUID()}`, name, arguments: args }, signal); }
    finally { turn.resume(); }
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
      // An approval that settles after the turn ended does not start a watchdog for it.
      if (paused || this.turn !== turn) return;
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
      // Both adapters name the models a prompt used in `_meta.quota.model_usage`; kept with the usage record.
      const quota = (answer._meta as { quota?: { model_usage?: Array<{ model?: unknown }> } } | null | undefined)?.quota;
      const models = (quota?.model_usage ?? []).map((entry) => entry.model).filter((model): model is string => typeof model === "string");
      if (models.length) this.usedModel = models[0];
      const usage = answer.usage ? { ...answer.usage, ...(models.length ? { models } : {}) } : undefined;
      return { text: turn.text, toolCalls: [], finishReason: answer.stopReason, ...(usage ? { usage } : {}) };
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
    // A call of a tool Raw offers this session: Raw's own rules and approvals apply when the bridge runs it.
    const bridged = bridgeToolName(params.toolCall);
    if (bridged !== undefined && this.tools.some((tool) => tool.name === bridged)) return choose(allow);
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
    this.live = undefined;
    if (live) {
      live.connection.close();
      await live.peer.stop(CLOSE_GRACE_MS);
    }
    await (await this.bridge)?.close();
    this.cleanupLaunch();
  }

  private cleanupLaunch(): void {
    if (!this.launch?.cleanup) return;
    const { cleanup, ...rest } = this.launch;
    this.launch = rest;
    cleanup();
  }
}

/** Raw's session agent for a backend CLI: Raw's loop owns history and turn state, the provider runs the CLI. */
export class AcpBackendAgent implements SessionAgent {
  constructor(private readonly session: AgentSession, readonly provider: BackendProvider) {}

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
  /** A panel action of a bridged tool runs in Raw; its note reaches the CLI with the next prompt. */
  runPanelAction(request: PanelActionRequest, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    return this.session.runPanelAction(request, onEvent);
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
    model: agent.provider.usedModel ?? agent.provider.currentValue("model") ?? agent.provider.modelConfig.model, agentName,
    startedTools: options.startedTools, failedTools: options.failedTools, session: agent.stats(), turn: agent.stats(options.firstRequest),
    context: { estimatedTokens: tokens, source, outputReserve: 0,
      ...(window ? { contextWindow: window, percentage: tokens / window * 100, inputBudget: window } : {}) } };
}
