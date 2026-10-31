import { createHash, randomUUID } from "node:crypto";
import { client, PROTOCOL_VERSION, type AnyMessage, type ClientCapabilities, type ClientConnection, type ContentBlock, type McpServerStdio, type RequestPermissionRequest,
  type PromptResponse, type RequestPermissionResponse, type SessionConfigOption, type SessionNotification } from "@agentclientprotocol/sdk";
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
import { AcpUpdateMapper, ASYNC_TASK_KINDS, cliToolIdentity, bridgeToolName, KNOWN_UPDATE_KINDS, type AcpTurnEvent } from "./acp-events.js";
import { bridgeProxyServer } from "./bridge/proxy.js";
import { commandsFromAcp, offeredFromConfigOptions, type BackendCommand, type BackendOffered } from "./options.js";
import { startBridge, type RawBridge } from "./bridge/server.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { BACKEND_LABELS, backendCompactTrigger, backendContextWindow, type BackendKind, type BackendSpec } from "./config.js";
import type { BackgroundEvent, BackgroundWork, CliTask, CliTaskState, PanelActionRequest, SessionAgent } from "./types.js";

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
  /** Declares the AIR async-tasks extension, so the adapter reports its background tasks (claude-agent-acp, codex-acp). */
  asyncTasks?: boolean;
}

export type { BackgroundEvent, CliTask, CliTaskState } from "./types.js";
const LIVE_STATES: ReadonlySet<CliTaskState> = new Set(["running", "paused"]);
const AIR_STATES: ReadonlySet<string> = new Set(["running", "paused", "completed", "failed", "stopped"]);

/**
 * How long Raw waits for Claude Code to answer a finished task with a turn of its own before it sends the note itself:
 * ~27× the largest gap measured between a completion and the turn it starts (74 ms; spikes of cli-background-work, 2026-10-30).
 */
export const CLAUDE_WAKE_AFTER_MS = 2000;
/**
 * How long a finished task's note waits for the exit code of its backgrounded call (Codex reports both in the same
 * millisecond, spike codex-air.log 23504); past it the note goes without the exit code.
 */
const EXIT_CODE_WAIT_MS = 1000;

/** The AIR capability a client declares in `initialize` (`air-extension.js` of claude-agent-acp). */
const AIR_CAPABILITIES: ClientCapabilities = { _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } } };
/** The method an `async_task_*` update is renamed to before the SDK, which does not know those kinds; order is kept. */
const ASYNC_TASK_METHOD = "_raw/async_task";
interface AsyncTaskNotification { sessionId: string; update: Record<string, unknown> }

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
/** How long discovery waits for the CLI's command list after `session/new`: ~20× the slowest measured arrival (51 ms). */
const COMMANDS_WAIT_MS = 1000;
/** The ACP `configOptions` category behind each option, in the order they are applied. */
const CATEGORIES = [["model", "model"], ["effort", "thought_level"], ["mode", "mode"]] as const;

/** Digest of what shapes a CLI conversation: a change of any part starts a fresh one instead of `session/load`. */
export function backendProfileDigest(spec: BackendSpec, systemPrompt: string | undefined): string {
  const prompt = createHash("sha256").update(systemPrompt ?? "").digest("hex");
  return createHash("sha256").update(JSON.stringify([spec.kind, spec.executable ?? "", prompt, spec.systemPromptMode])).digest("hex");
}

/**
 * What a kept adapter must share with the next operation's agent to serve it: the same agent, CLI profile, directory and
 * approval rule. Anything else starts a new adapter (Design, "Residency").
 */
export function backendResidentKey(options: { agentName: string; spec: BackendSpec; systemPrompt?: string; cwd: string; autoApprove: boolean }): string {
  return JSON.stringify([options.agentName, backendProfileDigest(options.spec, options.systemPrompt), options.cwd, options.autoApprove]);
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

/**
 * A turn the CLI started on its own (Claude Code after a background task) that no Raw turn has taken yet: its updates
 * wait here, and requests it makes wait for the turn that adopts it.
 */
interface PendingCliTurn {
  taskId: string;
  note: string;
  buffer: SessionNotification["update"][];
  /** The turn task's terminal state, when it ended before adoption. */
  ended?: CliTaskState;
  /** Settles held requests with the adopting turn, or `undefined` when the turn is not recorded. */
  adopt(turn: ActiveTurn | undefined): void;
  adopted: Promise<ActiveTurn | undefined>;
  /** Ends a follow once the turn task ends. */
  settle?: (state: CliTaskState) => void;
}

/** The answer text a CLI turn sent before Raw adopted it. */
const bufferedText = (pending: PendingCliTurn) => pending.buffer.flatMap((update) =>
  update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");

/** A finished task the CLI has not been told about yet; due when Raw delivers it itself (Codex at once, Claude Code later). */
interface Obligation { taskId: string; due: boolean; timer?: NodeJS.Timeout }

/** What the next `generate` runs for a CLI turn: follow the CLI's own turn, or wake it with the due notes. */
type CliStart = { follow: PendingCliTurn } | { wake: Obligation[]; note: string; sent?: boolean };

type McpServers = McpServerStdio[];

interface Live { peer: AcpPeer; connection: ClientConnection; died: Promise<never>; loadSession: boolean; images: boolean; ready: Promise<void> }

/**
 * Runs one external ACP agent process (and through it the user's CLI) for one session runtime. Raw's `AgentSession`
 * calls it like a model provider: each `generate` sends the new user messages as one `session/prompt` and returns the
 * CLI's answer; the CLI's own tool calls and notices travel through `onExternal`.
 */
export class AcpBackendProvider implements BackendProvider {
  readonly modelConfig: Readonly<ResolvedModelConfig>;
  /** The CLI's name as the user sees it (`Claude Code`, `Codex`). */
  readonly label: string;
  private readonly profileDigest: string;
  /** `backendResidentKey` of this provider's configuration. */
  readonly residentKey: string;
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
  /** The commands the CLI conversation last listed (ACP `available_commands_update`), for the dashboard's `/` menu. */
  commands: BackendCommand[] | undefined;
  /** The CLI conversation `session/load` is resuming, while it runs: its command list counts, its replay does not. */
  private loading: string | undefined;
  /** Called when a command list arrives; discovery waits for the first. */
  private commandsArrived: (() => void) | undefined;
  /** The CLI conversation's background tasks (AIR), kept across turns. */
  private readonly tasks = new Map<string, CliTask>();
  private readonly listeners = new Set<(event: BackgroundEvent) => void>();
  /** Calls that ended a turn running in the background: their later updates belong to the task, not to a turn. */
  private readonly backgroundCalls = new Set<string>();
  /** Task states the adapter sent that Raw does not know, each reported once. */
  private readonly unknownStates = new Set<string>();
  /** The CLI's own turn waiting for a Raw turn, and the one being followed. */
  private pendingCli: PendingCliTurn | undefined;
  private following: PendingCliTurn | undefined;
  /** Completions to deliver, oldest first; `owed` holds every task ever added, so a corrected end adds none again. */
  private obligations: Obligation[] = [];
  private readonly owed = new Set<string>();
  /** Tasks Raw asked to stop: their end is not news to the model. */
  private readonly stoppedByRaw = new Set<string>();
  /** Tasks other than monitors that stopped during a turn: the model stopped them (KillShell), so their end is not news. */
  private readonly stoppedInTurn = new Set<string>();
  /** Stop requests not yet answered. */
  private stopping = 0;
  /** Set by a fallback wake of Claude Code, cleared by its next turn task: it may still answer the completion itself. */
  private fallbackWatch = false;
  private cliStart: CliStart | undefined;
  /** Raw runs (turns, CLI turns, panel actions) in progress, and whether `cli_turn` was emitted since the last one began. */
  private running = 0;
  private signalled = false;
  /** Text the CLI sends outside any turn, gathered until the end of the current read. */
  private outside = "";
  private outsideFlush: NodeJS.Immediate | undefined;

  constructor(private config: AcpBackendProviderOptions) {
    this.modelConfig = backendModelConfig(config.agentName, config.spec);
    this.label = BACKEND_LABELS[config.spec.kind as BackendKind];
    this.profileDigest = backendProfileDigest(config.spec, config.systemPrompt);
    this.residentKey = backendResidentKey(config);
  }

  /**
   * Serves another operation of the session (Fixed decision 4 of cli-background-work): its persistence and approval
   * channel replace the last ones; `undefined` parks the provider with neither, so it writes nothing and asks no one.
   */
  rebind(host: { binding: AcpBackendProviderOptions["binding"]; approve?: AcpBackendProviderOptions["approve"] } | undefined): void {
    const { binding: _binding, approve: _approve, ...rest } = this.config;
    this.config = { ...rest, ...(host?.binding ? { binding: host.binding } : {}), ...(host?.approve ? { approve: host.approve } : {}) };
  }

  /** The CLI this provider runs. */
  get kind(): BackendKind { return this.config.spec.kind; }
  /** Whether `close()` has run. */
  get isClosed(): boolean { return this.closed; }

  /** Notices not yet given to a turn, taken so a host that closes this provider can give them to the next one. */
  drainNotices(): string[] {
    this.flushOutside();
    return this.queuedNotices.splice(0);
  }

  /** The adapter process of this runtime, while it runs. */
  get pid(): number | undefined { return this.live?.peer.child.pid; }
  /**
   * What the CLI offers to a new conversation configured as the agent's, for the dashboard before a session runs: starts
   * the adapter and a throwaway conversation, then stops them. The notices are what applying the agent's values said.
   */
  async discover(timeoutMs: number, signal?: AbortSignal): Promise<{ offered: BackendOffered; commands?: BackendCommand[]; notices: string[] }> {
    const notices: string[] = [];
    const notify = (message: string) => { notices.push(message); };
    const request = { system: "", messages: [], tools: [], timeoutMs, ...(signal ? { signal } : {}) } as ProviderRequest;
    try {
      await this.resolveLaunch(request, notify);
      await this.startup(request, (live) => this.open(live, notify, false, []));
      await this.firstCommands(signal);
      return { offered: offeredFromConfigOptions(this.options), ...(this.commands ? { commands: this.commands } : {}), notices };
    } finally { await this.close(); }
  }

  /**
   * Waits for the conversation's first command list: the CLIs send it 1–51 ms after `session/new` (measured 2026-10-30);
   * without one by COMMANDS_WAIT_MS, or once `signal` aborts, discovery goes on without it.
   */
  private async firstCommands(signal: AbortSignal | undefined): Promise<void> {
    if (this.commands || signal?.aborted) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        this.commandsArrived = resolve;
        timer = setTimeout(resolve, COMMANDS_WAIT_MS);
        onAbort = resolve;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      this.commandsArrived = undefined;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
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
  /** A notice already waiting is not added again (a host's startup warning given again with the notices it carried over). */
  noticeNextTurn(messages: readonly string[]): void {
    for (const message of messages) if (!this.queuedNotices.includes(message)) this.queuedNotices.push(message);
  }

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
    this.flushOutside();
    if (!request.signal?.aborted) for (const message of this.queuedNotices.splice(0)) notify(message);
    const override = this.override;
    this.override = undefined;
    this.tools = request.tools;
    const start = this.cliStart;
    this.cliStart = undefined;
    try {
      if (start && "follow" in start) return await this.follow(request, start.follow);
      return await this.runPrompt(request, notify, override, lastAnswer, start);
    } catch (error) {
      // A wake that never reached the CLI is still owed.
      if (start && "wake" in start && !start.sent) this.obligations.unshift(...start.wake);
      // A JSON-RPC error answer from the CLI (numeric code): its details say what went wrong, e.g. that the CLI exited.
      const answer = error as { code?: unknown; message?: string; data?: { details?: unknown } };
      if (typeof answer.code !== "number") throw error;
      if (answer.code === AUTH_REQUIRED) throw new BackendError("backend_auth", `${this.label} needs a login: ${this.launch?.authHint ?? answer.message}`);
      const details = typeof answer.data?.details === "string" ? `: ${answer.data.details}` : "";
      throw new BackendError("backend_error", `${this.label}: ${answer.message ?? "error"}${details}`);
    }
  }

  private async runPrompt(request: ProviderRequest, notify: (message: string) => void, override: BackendOptions | undefined,
    lastAnswer: number, start?: Extract<CliStart, { wake: Obligation[] }>): Promise<ProviderTurn> {
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
    // A wake sends the notes themselves; the transcript keeps them as the host's message.
    const contents = fresh.map((message, index) => start && index === fresh.length - 1 ? start.note : message.content);
    const prompt = contents.flatMap((content, index) => [...(index ? [{ type: "text", text: "\n\n" } as ContentBlock] : []), ...promptBlocks(content, images)]);
    if (start) {
      start.sent = true;
      // Claude Code may still answer the completion itself; its adapter is kept until its next turn shows whether it does.
      if (this.config.spec.kind === "claude") this.fallbackWatch = true;
    }
    const turn = await this.prompt(this.live!, prompt, request);
    // The CLI may change its options while it works (a model switch); the dashboard lists what it offers at the end.
    this.saveOffered();
    return turn;
  }

  /** Records the CLI's own turn: its buffered updates first, then live ones until its turn task ends. */
  private async follow(request: ProviderRequest, pending: PendingCliTurn): Promise<ProviderTurn> {
    const live = this.live;
    if (this.pendingCli !== pending || !live || !this.cliSessionId) throw new BackendError("backend_exited", `${this.label}'s turn ended before Raw could record it`);
    return this.prompt(live, undefined, request, pending);
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
    app.onNotification(ASYNC_TASK_METHOD, (params: unknown) => params as AsyncTaskNotification, ({ params }) => this.task(params));
    // Unknown update kinds never reach the SDK, which would reject them before any handler (Invariant 8).
    const connection = app.connect({ writable: peer.stream.writable, readable: peer.stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({ transform: (message, controller) => {
        const update = (message as { method?: unknown; params?: { update?: { sessionUpdate?: unknown } } });
        const kind = update.method === "session/update" ? update.params?.update?.sessionUpdate : undefined;
        // AIR task updates go on under a method of their own, in their place among the other messages.
        if (typeof kind === "string" && ASYNC_TASK_KINDS.has(kind)) { controller.enqueue({ ...message, method: ASYNC_TASK_METHOD } as AnyMessage); return; }
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
    died.catch((error: unknown) => {
      if (this.live === live) { this.live = undefined; this.cliSessionId = undefined; }
      this.loseTasks(error instanceof Error ? error.message : String(error));
    });
    live.ready = connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: launch.asyncTasks ? AIR_CAPABILITIES : {} })
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
      // The conversation keeps its stored list unless the CLI sends another, also while it loads (codex-acp 2.3.0 does).
      this.commands = stored.commands;
      this.loading = stored.cliSessionId;
      try {
        // Updates that replay the conversation arrive before this answer; with no active turn they are not recorded again.
        const loaded = await live.connection.agent.request("session/load", { sessionId: stored.cliSessionId, cwd: this.config.cwd,
          mcpServers, ...meta }).finally(() => { this.loading = undefined; });
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
    // A new conversation has only the list it sends.
    this.commands = undefined;
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
    // A conversation that has sent no list yet keeps the stored one.
    const commands = this.commands ?? stored.commands;
    if (JSON.stringify(offered) !== JSON.stringify(stored.offered) || JSON.stringify(commands) !== JSON.stringify(stored.commands)) {
      binding.store.writeExternal(binding.sessionId, binding.owner, { ...stored, offered, ...(commands ? { commands } : {}) });
    }
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
    const pending = this.turn ? undefined : this.pendingCli;
    const turn = this.turn ?? await pending?.adopted;
    if (pending && !turn) throw new Error("the background turn was not recorded");
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

  /** Sends `prompt` and records the answer; with `follow`, sends nothing and records the CLI's own turn until it ends. */
  private async prompt(live: Live, prompt: ContentBlock[] | undefined, request: ProviderRequest, follow?: PendingCliTurn): Promise<ProviderTurn> {
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
      for (const event of this.closeCalls(turn, code, message)) this.dispatch(turn, event);
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
    // The CLI's own turn waiting for this one: a follow takes it, and a user turn that raced it records it first.
    const pending = follow ?? this.pendingCli;
    if (pending) this.adopt(pending, turn);
    const response: Promise<{ stopReason: string; usage?: PromptResponse["usage"]; _meta?: PromptResponse["_meta"] }> = follow ? this.followEnd(follow)
      : this.exitFirst(live, live.connection.agent.request("session/prompt", { sessionId, prompt: prompt! }));
    response.catch(() => {});
    try {
      const answer = await Promise.race([response, idle, aborted, live.died]);
      for (const event of this.closeCalls(turn, "backend_error", `${this.label} did not report a result for this call`)) this.dispatch(turn, event);
      // Both adapters name the models a prompt used in `_meta.quota.model_usage`; kept with the usage record.
      const quota = (answer._meta as { quota?: { model_usage?: Array<{ model?: unknown }> } } | null | undefined)?.quota;
      const models = (quota?.model_usage ?? []).map((entry) => entry.model).filter((model): model is string => typeof model === "string");
      if (models.length) this.usedModel = models[0];
      const usage = answer.usage ? { ...answer.usage, ...(models.length ? { models } : {}) } : undefined;
      return { text: turn.text, toolCalls: [], finishReason: answer.stopReason, ...(usage ? { usage } : {}) };
    } catch (error) {
      // Saved before the adapter stops: the conversation stays the session's, and the next turn loads it with these.
      // A store failure here is reported and does not keep the cleanup below from running.
      try { this.saveOffered(); }
      catch (saveError) { (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} options not saved: ${(saveError as Error).message}\n`); }
      const cancelled = error instanceof BackendError && error.code === "aborted";
      const stopping = cancelled || (error instanceof BackendError && error.code === "backend_unresponsive");
      if (follow) {
        // A followed turn is the CLI's task: stopping it leaves the adapter and its other tasks running.
        if (stopping) await this.stopTask(follow.taskId);
        detach("backend_error", (error as Error).message);
        if (live.peer.exited()) await this.stopPeer(live);
        throw error;
      }
      if (stopping) {
        // The CLI is asked to stop first so it can save its conversation, then the whole tree goes (Invariant 7);
        // the next turn starts a new adapter and loads the conversation.
        void live.connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
        let grace: NodeJS.Timeout | undefined;
        const answered = await Promise.race([response.then(() => true, () => true), live.died.then(() => false, () => false),
          new Promise<boolean>((resolve) => { grace = setTimeout(() => resolve(false), CANCEL_GRACE_MS); })]);
        clearTimeout(grace);
        // A CLI that answered the cancel keeps its background tasks, as its own Esc does (Fixed decision 5).
        if (cancelled && answered && !live.peer.exited() && [...this.tasks.values()].some((task) => LIVE_STATES.has(task.state))) {
          detach("cancelled", "cancelled");
          throw error;
        }
      }
      detach("backend_error", (error as Error).message);
      await this.stopPeer(live);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
      if (this.turn === turn) this.turn = undefined;
      if (pending && this.following === pending) this.following = undefined;
      this.pendOpenTurn();
    }
  }

  /** The turn the CLI started becomes this one's: its buffer is replayed into it, and its held requests are served by it. */
  private adopt(pending: PendingCliTurn, turn: ActiveTurn): void {
    if (this.pendingCli === pending) this.pendingCli = undefined;
    this.following = pending;
    for (const update of pending.buffer.splice(0)) for (const event of turn.mapper.map(update)) this.dispatch(turn, event);
    pending.adopt(turn);
  }

  /** Resolves when a followed turn's task ends: `completed` ends the turn, `stopped` cancels it, `failed` is an error. */
  private followEnd(pending: PendingCliTurn): Promise<{ stopReason: string }> {
    return new Promise<CliTaskState>((resolve) => { if (pending.ended) resolve(pending.ended); else pending.settle = resolve; })
      .then((state) => {
        if (state === "failed" || state === "lost") {
          const error = this.tasks.get(pending.taskId)?.error;
          throw new BackendError("backend_error", `${this.label}'s turn failed${error ? `: ${error}` : ""}`);
        }
        return { stopReason: state === "completed" ? "end_turn" : "cancelled" };
      });
  }

  /** A turn task still open when Raw's turn ends goes on as a CLI turn of its own (Design, "CLI turn, Claude Code"). */
  private pendOpenTurn(): void {
    if (this.turn || this.pendingCli || this.closed) return;
    const open = [...this.tasks.values()].find((task) => task.type === "turn" && LIVE_STATES.has(task.state) && task.id !== this.following?.taskId);
    if (open) this.pendCliTurn(open);
  }

  private pendCliTurn(task: CliTask): void {
    let adopt!: (turn: ActiveTurn | undefined) => void;
    const adopted = new Promise<ActiveTurn | undefined>((resolve) => { adopt = resolve; });
    this.pendingCli = { taskId: task.id, note: task.description ?? task.name, buffer: [], adopt, adopted };
    this.signal();
  }

  /** Ends the turn's open calls; a call the CLI moved to the background ends running, and its later updates go to its task. */
  private closeCalls(turn: ActiveTurn, code: string, message: string): AcpTurnEvent[] {
    for (const id of turn.mapper.backgroundedCalls()) this.backgroundCalls.add(id);
    return turn.mapper.closeOpen(code, message, (id) => [...this.tasks.values()].find((task) => task.toolCallId === id)?.id);
  }

  private update(notification: SessionNotification): void {
    const turn = this.turn;
    const { update } = notification;
    if (notification.sessionId !== this.cliSessionId) {
      // The conversation being loaded may list its commands before `session/load` answers; the rest is its replay.
      if (notification.sessionId === this.loading && update.sessionUpdate === "available_commands_update") this.listCommands(commandsFromAcp(update.availableCommands));
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      // A task's command reports its exit code on its tool call (codex-acp), inside its turn or after it.
      const exit = (update._meta as { terminal_exit?: { exit_code?: unknown } } | null | undefined)?.terminal_exit;
      const task = [...this.tasks.values()].find((item) => item.toolCallId === update.toolCallId);
      if (task && exit && "exit_code" in exit) {
        task.exitCode = typeof exit.exit_code === "number" ? exit.exit_code : null;
        this.emitTasks();
      }
      // A call that ended its turn running in the background belongs to its task from then on.
      if (this.backgroundCalls.has(update.toolCallId)) {
        if (update.status === "completed" || update.status === "failed") {
          this.backgroundCalls.delete(update.toolCallId);
          // The note of its finished task can now carry the exit code.
          const owed = task && this.obligations.find((obligation) => obligation.taskId === task.id);
          if (owed && this.config.spec.kind !== "claude") this.makeDue(owed);
        }
        return;
      }
    }
    if (!turn) {
      // Outside a turn session state still changes: the options, the context and the commands the CLI reports.
      if (update.sessionUpdate === "config_option_update") this.options = update.configOptions;
      else if (update.sessionUpdate === "usage_update") this.context = { used: update.used, size: update.size };
      else if (update.sessionUpdate === "available_commands_update") this.listCommands(commandsFromAcp(update.availableCommands));
      // The CLI's own turn waits for the Raw turn that records it; other text is kept as a notice (Invariant 1).
      else if (this.pendingCli) this.pendingCli.buffer.push(update);
      else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") this.noticeOutside(update.content.text);
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
    else if (event.type === "commands") this.listCommands(event.commands);
    else if (event.type === "unknown") this.reportUnknown(event.kind);
    else request.onExternal?.(event as ExternalTurnEvent);
  }

  /** The CLI's new command list replaces the last one and is saved with the session; a store failure is only reported. */
  private listCommands(commands: BackendCommand[]): void {
    this.commands = commands;
    this.commandsArrived?.();
    try { this.saveOffered(); }
    catch (error) { (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} commands not saved: ${(error as Error).message}\n`); }
  }

  /** Text outside any turn: one notice per read, for the listeners now and for the next turn. */
  private noticeOutside(text: string): void {
    this.outside += text;
    this.outsideFlush ??= setImmediate(() => this.flushOutside());
  }

  private flushOutside(): void {
    if (this.outsideFlush) clearImmediate(this.outsideFlush);
    this.outsideFlush = undefined;
    const text = this.outside;
    this.outside = "";
    if (!text) return;
    this.queuedNotices.push(text);
    this.emit({ type: "notice", text });
  }

  /** Counts an update Raw does not handle and reports its kind once per runtime. */
  private reportUnknown(kind: string): void {
    const seen = this.unknownKinds.get(kind) ?? 0;
    this.unknownKinds.set(kind, seen + 1);
    if (!seen) (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} sent unknown update ${kind}\n`);
  }

  /** An AIR task update of this conversation: the task registry follows the adapter's state machine. */
  private task({ sessionId, update }: AsyncTaskNotification): void {
    if (sessionId !== this.cliSessionId) return;
    const id = typeof update.asyncTaskId === "string" ? update.asyncTaskId : undefined;
    if (!id) return;
    const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
    const known = this.tasks.get(id);
    // Each of the three kinds may carry the output path and the tool call (`async-tasks.js` publishProgress, publishState).
    const path = text(update.outputFilePath);
    const toolCallId = text(update.toolCallId);
    if (update.sessionUpdate === "async_task_spawned") {
      const description = text(update.description);
      this.tasks.set(id, { id, name: text(update.name) ?? id, type: text(update.taskType) ?? "task", state: known?.state ?? "running",
        canStop: update.canStop === true, startedAt: known?.startedAt ?? Date.now(), ...(description ? { description } : {}),
        ...(toolCallId ?? known?.toolCallId ? { toolCallId: toolCallId ?? known!.toolCallId! } : {}),
        ...(path ?? known?.outputFilePath ? { outputFilePath: path ?? known!.outputFilePath! } : {}) });
      // Listeners see the state this update leaves, the CLI turn it opens included.
      if (this.tasks.get(id)!.type === "turn" && !known) this.turnSpawned(this.tasks.get(id)!);
      this.emitTasks();
      return;
    }
    if (!known) return;
    let changed = false;
    if (path && path !== known.outputFilePath) { known.outputFilePath = path; changed = true; }
    if (toolCallId && toolCallId !== known.toolCallId) { known.toolCallId = toolCallId; changed = true; }
    const state = update.sessionUpdate === "async_task_state_update" ? text(update.state) : undefined;
    if (state && !AIR_STATES.has(state)) {
      if (!this.unknownStates.has(state)) {
        this.unknownStates.add(state);
        (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} sent unknown task state ${state}\n`);
      }
    } else if (state && state !== known.state && known.state !== "lost") {
      const live = LIVE_STATES.has(state as CliTaskState);
      // An ended task never runs again; a later end corrects an earlier one (`async-tasks.js` finish: a provisional `stopped`).
      if (!live || LIVE_STATES.has(known.state)) {
        known.state = state as CliTaskState;
        if (!live) known.endedAt = Date.now();
        const error = text(update.error);
        if (error) known.error = error;
        changed = true;
      }
    }
    if (!changed) return;
    // The completion it owes is recorded before listeners look (a host closes an adapter with no work left).
    if (!LIVE_STATES.has(known.state)) this.taskEnded(known);
    this.emitTasks();
  }

  /**
   * Claude Code started a turn: it answers every completion before it (they are no longer owed, and a fallback wake has
   * its answer), and with no Raw turn running it waits to be recorded as a CLI turn.
   */
  private turnSpawned(task: CliTask): void {
    for (const obligation of this.obligations) clearTimeout(obligation.timer);
    this.obligations = [];
    this.fallbackWatch = false;
    if (this.turn) return;
    const pending = this.pendingCli;
    if (!pending) { this.pendCliTurn(task); return; }
    // A turn after one that ended unrecorded: both are recorded as one CLI turn.
    if (pending.ended) Object.assign(pending, { taskId: task.id, note: `${pending.note}\n${task.description ?? task.name}`, ended: undefined });
  }

  private taskEnded(task: CliTask): void {
    if (task.type === "turn") {
      if (this.pendingCli?.taskId === task.id) this.pendingCli.ended = task.state;
      if (this.following?.taskId === task.id) { this.following.ended = task.state; this.following.settle?.(task.state); }
      return;
    }
    // An end Raw did not cause is news to the model, a monitor's exit or expiry included: Claude Code answers it itself
    // (spikes claude-monitor-exit.log, claude-monitor-timeout.log), else Raw delivers it. A monitor expires on its own clock,
    // inside a turn or not; another task stopped inside a turn is the model's own stop (KillShell), and stays so when its
    // later updates arrive after the turn.
    if (this.stoppedByRaw.has(task.id) || this.owed.has(task.id)) return;
    if (task.state === "stopped" && task.type !== "monitor" && this.turn) this.stoppedInTurn.add(task.id);
    if (task.state === "stopped" ? this.stoppedInTurn.has(task.id) : task.state !== "completed" && task.state !== "failed") return;
    this.owed.add(task.id);
    // Codex is woken once the call's exit code is in (its call still open waits for it); Claude Code is given time to answer itself.
    const waitsForExit = task.toolCallId !== undefined && this.backgroundCalls.has(task.toolCallId);
    const obligation: Obligation = { taskId: task.id, due: this.config.spec.kind !== "claude" && !waitsForExit };
    if (!obligation.due) obligation.timer = setTimeout(() => this.makeDue(obligation), this.config.spec.kind === "claude" ? CLAUDE_WAKE_AFTER_MS : EXIT_CODE_WAIT_MS);
    this.obligations.push(obligation);
    this.signal();
  }

  private makeDue(obligation: Obligation): void {
    clearTimeout(obligation.timer);
    if (obligation.due) return;
    obligation.due = true;
    this.signal();
  }

  /** The note a completion is delivered with: `Background command "<name>" completed (exit code N).` */
  private obligationNote({ taskId }: Obligation): string {
    const task = this.tasks.get(taskId)!;
    const exit = typeof task.exitCode === "number" ? ` (exit code ${task.exitCode})` : "";
    return `Background ${task.type === "shell" ? "command" : "task"} "${task.name}" ${task.state}${exit}.`;
  }

  /** Tells the host a CLI turn waits, once until it runs, and never while a Raw run holds the session. */
  private signal(): void {
    if (this.running || this.signalled || this.closed || this.cliTurnNote() === undefined) return;
    this.signalled = true;
    this.emit({ type: "cli_turn" });
  }

  /** The adapter is gone: its live tasks went with it. */
  private loseTasks(message: string): void {
    const lost = [...this.tasks.values()].filter((task) => LIVE_STATES.has(task.state));
    for (const task of lost) Object.assign(task, { state: "lost", endedAt: Date.now(), error: message });
    this.backgroundCalls.clear();
    // The CLI's own turn went with its adapter: what it asked is refused, what it said is kept as a notice, and a
    // followed turn ends with the exit.
    const pending = this.pendingCli;
    pending?.adopt(undefined);
    this.pendingCli = undefined;
    const said = pending ? bufferedText(pending) : "";
    if (said && !this.closed) {
      const notice = `${this.label} exited before Raw recorded its turn after a background task:\n${said}`;
      this.queuedNotices.push(notice);
      this.emit({ type: "notice", text: notice });
    }
    // Completions the CLI was owed cannot reach it: they are named with the lost tasks.
    const owed = this.obligations.map((obligation) => this.tasks.get(obligation.taskId)!);
    for (const obligation of this.obligations) clearTimeout(obligation.timer);
    this.obligations = [];
    this.fallbackWatch = false;
    if (!lost.length && !owed.length && !pending) return;
    // The exit first: a host told only that no work is left would close the provider as idle and miss what was lost.
    if (!this.closed) this.emit({ type: "exited", message, lost: [...lost, ...owed].map((task) => task.name) });
    this.emitTasks();
  }

  private emitTasks(): void { this.emit({ type: "tasks", tasks: this.backgroundTasks() }); }

  /** Listeners never throw into the transport. */
  private emit(event: BackgroundEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); }
      catch (error) { (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: background listener failed: ${(error as Error).message}\n`); }
    }
  }

  /** Reports work outside Raw's turns; returns the unsubscribe. */
  onBackground(listener: (event: BackgroundEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The conversation's background tasks, oldest first. */
  backgroundTasks(): CliTask[] { return [...this.tasks.values()].map((task) => ({ ...task })); }

  /** Whether the CLI has work that outlives the turn: a live task, its own turn not yet recorded, or a completion it is owed. */
  hasBackgroundWork(): boolean {
    return [...this.tasks.values()].some((task) => LIVE_STATES.has(task.state)) || this.pendingCli !== undefined || this.obligations.length > 0;
  }

  /** `hasBackgroundWork()`, a fallback wake that Claude Code may still answer with a turn of its own, or a stop not yet answered. */
  keepsAdapter(): boolean { return this.hasBackgroundWork() || this.fallbackWatch || this.stopping > 0; }

  /**
   * The note of the CLI turn waiting to run: Claude Code's own turn, else the due completions joined, oldest first
   * (Codex at once; Claude Code after CLAUDE_WAKE_AFTER_MS without a turn of its own).
   */
  cliTurnNote(): string | undefined {
    if (this.pendingCli) return this.pendingCli.note;
    const due = this.obligations.filter((obligation) => obligation.due);
    return due.length ? due.map((obligation) => this.obligationNote(obligation)).join("\n") : undefined;
  }

  /** The next `generate` runs the waiting CLI turn; the due completions it delivers are taken now. */
  beginCliTurn(): { note: string; notice: string } | undefined {
    const note = this.closed ? undefined : this.cliTurnNote();
    if (note === undefined) return undefined;
    if (this.pendingCli) this.cliStart = { follow: this.pendingCli };
    else {
      const wake = this.obligations.filter((obligation) => obligation.due);
      this.obligations = this.obligations.filter((obligation) => !obligation.due);
      // The note names no output and no session (codex-acp keeps the terminal's id to itself): the model is told to
      // read it rather than answer from memory (Decision 2026-10-30 of cli-background-work).
      const prompt = `${note}\n${wake.length > 1 ? "Read their output" : "Read its output"} before you answer.`;
      this.cliStart = { wake, note: prompt };
      return { note: prompt, notice: `${this.label} continues: ${note}` };
    }
    return { note, notice: `${this.label} continues: ${note}` };
  }

  /** After a CLI turn's run: one that never reached `generate` is abandoned (follow) or still owed (wake). */
  async endCliTurn(): Promise<void> {
    const start = this.cliStart;
    this.cliStart = undefined;
    if (!start) return;
    if ("follow" in start) await this.abandonCliTurn();
    else this.obligations.unshift(...start.wake);
  }

  /**
   * The host could not record the CLI's own turn: it is stopped, what it asked is refused, and its text is kept as a
   * notice (Design, "Abandoned adoption").
   */
  async abandonCliTurn(why = "Raw could not record it"): Promise<void> {
    const pending = this.pendingCli;
    if (!pending) return;
    this.pendingCli = undefined;
    const text = bufferedText(pending);
    // Kept before the stop: a host may close this provider on the stop's state update, taking the notices with it.
    const notice = `${this.label} started a turn after a background task, but ${why}; it was stopped${text ? `\n${text}` : ""}`;
    this.queuedNotices.push(notice);
    this.emit({ type: "notice", text: notice });
    if (!pending.ended) await this.stopTask(pending.taskId);
    pending.adopt(undefined);
  }

  /** Whether the waiting CLI turn is Claude Code's own (to follow), rather than completions to wake the CLI with. */
  get ownTurnPending(): boolean { return this.pendingCli !== undefined; }

  /** A Raw run starts (a turn, a CLI turn, a panel action): no CLI turn is signalled until it ends. */
  runStarted(): void { this.running++; this.signalled = false; }
  runEnded(): void { this.running = Math.max(0, this.running - 1); this.signal(); }

  /** Asks the CLI to stop a live task it lets Raw stop; false for an unknown or ended task, or a closed runtime. */
  async stopTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    const live = this.live;
    const sessionId = this.cliSessionId;
    if (this.closed || !task || !LIVE_STATES.has(task.state) || !task.canStop || !live || !sessionId) return false;
    // Bounded like a cancelled prompt's answer (CANCEL_GRACE_MS); past it the request is cancelled and the task left as it is.
    // Its end is not news to the model, whichever arrives first: the answer or the state update.
    this.stoppedByRaw.add(id);
    // The adapter is kept until the answer: the CLI says what it stopped before it answers (claude-air-stop-shell.log).
    this.stopping++;
    const cancel = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), CANCEL_GRACE_MS); });
    let stopped = false;
    try {
      const answer = await Promise.race([late, live.died.catch(() => "late" as const),
        live.connection.agent.request<{ stopped?: unknown }>("_session/async_task/stop", { sessionId, asyncTaskId: id }, { cancellationSignal: cancel.signal })]);
      if (answer === "late") {
        cancel.abort();
        (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: ${this.config.spec.kind} did not answer the stop of task ${id} within ${CANCEL_GRACE_MS} ms\n`);
        return false;
      }
      stopped = answer?.stopped === true;
    } catch { return false; }
    finally {
      clearTimeout(timer);
      this.stopping--;
      if (!stopped) {
        // Not stopped by Raw: an end that came meanwhile is the task's own, and owed like any other.
        this.stoppedByRaw.delete(id);
        if (!LIVE_STATES.has(task.state)) this.taskEnded(task);
      }
      // The adapter reports the stop as a state update; a stop it confirmed is final either way.
      if (stopped && LIVE_STATES.has(task.state)) Object.assign(task, { state: "stopped", endedAt: Date.now() });
      // Listeners see the stop settled: a host may now close an adapter with no work left.
      this.flushOutside();
      this.emitTasks();
    }
    return stopped;
  }

  /** Count of each unknown update kind this runtime received. */
  get unknownUpdates(): ReadonlyMap<string, number> { return new Map(this.unknownKinds); }

  private async permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Asked by the CLI's own turn before a Raw turn took it: answered by that turn, or refused if none does.
    const turn = this.turn ?? await this.pendingCli?.adopted;
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
    this.pendingCli?.adopt(undefined);
    this.pendingCli = undefined;
    for (const obligation of this.obligations) clearTimeout(obligation.timer);
    this.obligations = [];
    this.fallbackWatch = false;
    if (this.outsideFlush) clearImmediate(this.outsideFlush);
    const live = this.live;
    this.live = undefined;
    if (live) {
      live.connection.close();
      await live.peer.stop(CLOSE_GRACE_MS);
    }
    await (await this.bridge)?.close();
    this.cleanupLaunch();
    this.listeners.clear();
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
  /** The CLI's background work, for an ACP backend (Claude Code, Codex); agy has none. */
  readonly background: BackgroundWork | undefined;
  private readonly acp: AcpBackendProvider | undefined;

  constructor(private readonly session: AgentSession, readonly provider: BackendProvider) {
    const acp = provider instanceof AcpBackendProvider ? provider : undefined;
    this.acp = acp;
    this.background = acp && {
      tasks: () => acp.backgroundTasks(),
      onEvent: (listener) => acp.onBackground(listener),
      stop: (id) => acp.stopTask(id),
      stopAll: async () => { await Promise.all(acp.backgroundTasks().filter((task) => task.state === "running" || task.state === "paused").map((task) => acp.stopTask(task.id))); },
      hasWork: () => acp.hasBackgroundWork(),
      keepsAdapter: () => acp.keepsAdapter(),
      cliTurnNote: () => acp.cliTurnNote(),
      runCliTurn: (onEvent) => this.runCliTurn(onEvent),
      abandonCliTurn: () => acp.abandonCliTurn(),
    };
  }

  /**
   * Ends this operation's agent but keeps its provider when the CLI still has background work (Design, "Residency"):
   * the provider is returned parked, with no binding or approval channel. Without such work nothing is closed and
   * `undefined` is returned; the host closes the agent as usual.
   */
  async detach(): Promise<AcpBackendProvider | undefined> {
    const acp = this.acp;
    if (!acp || acp.isClosed || !acp.keepsAdapter()) return undefined;
    await this.session.close();
    acp.rebind(undefined);
    return acp;
  }

  /** Runs `work` as a Raw run the provider knows of, so it signals no CLI turn meanwhile. */
  private async held<T>(work: () => Promise<T>): Promise<T> {
    this.acp?.runStarted();
    try { return await work(); } finally { this.acp?.runEnded(); }
  }

  /**
   * Runs the CLI turn waiting now (Fixed decision 6 of cli-background-work): the note is the host's message, a notice
   * `<CLI> continues: <note>` its visible line. With none waiting it records nothing.
   */
  async runCliTurn(onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    const acp = this.acp;
    if (!acp) return { status: "completed", steps: 0, text: "" };
    return this.held(async () => {
      const start = acp.beginCliTurn();
      if (!start) return { status: "completed", steps: 0, text: "" } as RunResult;
      try { return await this.session.run(start.note, onEvent, { origin: "cli", notice: start.notice }); }
      finally { await acp.endCliTurn(); }
    });
  }

  get state(): AgentState { return this.session.state; }
  get transcript(): readonly ModelMessage[] { return this.session.transcript; }
  start(source: "create" | "resume", onEvent?: (event: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.session.start(source, onEvent, signal);
  }
  /** Values for the next turn only (Fixed decision 6). */
  setTurnOverride(options: BackendOptions | undefined): void { this.provider.setTurnOverride(options); }
  run(input: UserInput, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    return this.held(() => this.session.run(input, onEvent)).finally(() => this.provider.setTurnOverride(undefined));
  }
  /** A panel action of a bridged tool runs in Raw; its note reaches the CLI with the next prompt. */
  runPanelAction(request: PanelActionRequest, onEvent?: (event: RunEvent) => void): Promise<RunResult> {
    return this.held(() => this.session.runPanelAction(request, onEvent));
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

/**
 * Session metrics of a backend session: the CLI's own context report, no output reserve. A window the model sets for a CLI
 * that takes one wins over the reported one (Claude Code reports the model's largest window, whatever it compacts against), and the trigger is the
 * CLI's, from `backendCompactTrigger`.
 */
export function measureBackend(agent: AcpBackendAgent, agentName: string, options: MeasureOptions, spec?: BackendSpec): SessionMetrics {
  const { tokens, source, window: reported } = agent.contextUsage();
  const window = (spec ? backendContextWindow(spec) : undefined) ?? reported;
  const trigger = spec ? backendCompactTrigger(spec) : undefined;
  return { measuredAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - options.startedAt)),
    model: agent.provider.usedModel ?? agent.provider.currentValue("model") ?? agent.provider.modelConfig.model, agentName,
    startedTools: options.startedTools, failedTools: options.failedTools, session: agent.stats(), turn: agent.stats(options.firstRequest),
    context: { estimatedTokens: tokens, source, outputReserve: 0,
      ...(window ? { contextWindow: window, percentage: tokens / window * 100, inputBudget: window } : {}),
      ...(trigger ? { compactTrigger: trigger.tokens, ...(trigger.estimated ? { compactTriggerEstimated: true } : {}) } : {}) } };
}
