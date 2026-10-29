import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MAX_FRAME_BYTES } from "../acp/transport.js";
import { spawnLinePeer, type LinePeer } from "../acp/peer.js";
import { imagePlaceholderText, type ModelMessage, type ProviderAdapter, type ProviderRequest, type ProviderTurn, type ResolvedModelConfig,
  type UserInput } from "../llm/types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../tools/results.js";
import type { ExternalSession, SessionOwner, SessionStore } from "../sessions/store.js";
import { BackendError, backendModelConfig, backendProfileDigest, type BackendOptions, type BackendProvider } from "./acp-agent.js";
import { findExecutable } from "./adapters.js";
import { offeredFromAgyCatalog } from "./options.js";
import { AgyEventMapper, type AgyTurnEvent } from "./agy-events.js";
import type { BackendSpec } from "./config.js";

export const AGY_MISSING = "Install Antigravity (`agy`) and log in, or set backend.executable";
export const AGY_APPEND = "agy cannot add to its own system prompt; the agent's prompt replaces it";
export const AGY_EMPTY_PROMPT = "agy cannot run with an empty system prompt; it keeps its own";
const FRESH = "This agy conversation starts here; it does not see earlier turns";

/**
 * The tools a Raw agent file lists by default: the names agy 1.4.10 reports in `init.tools` that its executor also
 * resolves, except `finish`, a subagent's way to return structured output (an agent given it prints that output, `{}`,
 * before its reply). agy has no wildcard (`tools: ["*"]` fails) and fails a run on any name it does not resolve, so a name a
 * later agy drops is removed and the turn retried (`AgyBackendProvider`).
 */
export const AGY_DEFAULT_TOOLS: readonly string[] = Object.freeze(["ask_custom_permission", "ask_permission", "ask_question",
  "define_subagent", "find_by_name", "generate_image", "grep_search", "invoke_subagent", "list_dir", "list_plugin_accounts",
  "manage_subagents", "manage_task", "multi_replace_file_content", "notebook_edit", "read_url_content", "replace_file_content",
  "run_command", "run_workflow", "schedule", "search_marketplace", "search_web", "send_message", "view_file", "wait", "write_to_file"]);

/** How long a finished stdout waits for the exit to be reported, and the reverse. */
const EXIT_WAIT_MS = 1000;

// ---------- models: families and their efforts (the rules of cross-review's agy reviewer) ----------

/** A model `agy models` lists: a family whose efforts are slug suffixes (`gemini-3.8-flash-high`), or a model of its own. */
export interface AgyModel { slug: string; name: string; efforts: string[]; variants: Array<{ slug: string; name: string; effort: string }> }

const EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

/** `agy models` output (`slug<TAB>display name` per line) grouped into families in order of first appearance. */
export function parseAgyCatalog(text: string): AgyModel[] | undefined {
  const families: AgyModel[] = [];
  const bySlug = new Map<string, AgyModel>();
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim();
    const display = line.slice(tab + 1).trim() || slug;
    const match = EFFORT_SUFFIX.exec(slug);
    if (!match) {
      if (!bySlug.has(slug)) { const model = { slug, name: display, efforts: [], variants: [] }; bySlug.set(slug, model); families.push(model); }
      continue;
    }
    let family = bySlug.get(match[1]!);
    if (!family) {
      family = { slug: match[1]!, name: display.replace(/\s*\([^()]*\)\s*$/, "") || match[1]!, efforts: [], variants: [] };
      bySlug.set(match[1]!, family);
      families.push(family);
    }
    if (!family.efforts.includes(match[2]!)) family.efforts.push(match[2]!);
    family.variants.push({ slug, name: display, effort: match[2]! });
  }
  return families.length ? families : undefined;
}

/**
 * How agy 1.4.10 refuses a model or effort it does not know, as a `result` error (both start "invalid model selection
 * (--model … --effort …):"): `model X is not recognized as a known model…` or `invalid --effort "X" (valid: …)`.
 */
const INVALID_MODEL = /^invalid model selection\b.*\bis not recognized\b/s;
const INVALID_EFFORT = /^invalid model selection\b.*\binvalid --effort "/s;

/** One `agy models` read: shared by the turns waiting on it, and stopped once the last of them leaves. */
interface CatalogRead { models: Promise<AgyModel[] | undefined>; waiting: number; done: boolean; stop(): void }
const catalogs = new Map<string, CatalogRead>();

function readModels(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): CatalogRead {
  const lines: string[] = [];
  let peer: LinePeer | undefined;
  let stopped!: () => void;
  const read: CatalogRead = { waiting: 0, done: false, stop: () => stopped(), models: new Promise<AgyModel[] | undefined>((resolve) => {
    try { peer = spawnLinePeer({ command: executable, args: ["models"], env, onLine: (line) => lines.push(line), maxFrameBytes: MAX_FRAME_BYTES }); }
    catch { resolve(undefined); return; }
    // The first outcome wins, and the read settles once the child and what it started in its group are gone.
    let settling = false;
    const settle = (models: AgyModel[] | undefined) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      void peer!.stop(0).catch(() => {}).then(() => resolve(models));
    };
    const timer = setTimeout(() => stopped(), timeoutMs);
    stopped = () => settle(undefined);
    peer.child.stdin.end();
    peer.spawnFailure.catch(() => settle(undefined));
    // `close` comes once stdout has ended, so every line was read.
    peer.child.once("close", (code) => settle(code === 0 ? parseAgyCatalog(lines.join("\n")) : undefined));
  }) };
  stopped ??= () => {};
  return read;
}

/**
 * The catalog of the agy at `executable`, read once per process; undefined when `agy models` cannot be read within
 * `timeoutMs` (the reading turn's `request_timeout_ms`). A failed read is not kept, so the next turn reads again. A read
 * is shared by the turns waiting on it; one that leaves through `signal` stops waiting, and the last to leave stops it.
 */
export function agyCatalog(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<AgyModel[] | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  let read = catalogs.get(executable);
  if (!read) {
    const started = readModels(executable, env, timeoutMs);
    read = started;
    catalogs.set(executable, started);
    void started.models.then((models) => { started.done = true; if (!models && catalogs.get(executable) === started) catalogs.delete(executable); });
  }
  const shared = read;
  if (shared.done) return shared.models;
  shared.waiting++;
  return new Promise<AgyModel[] | undefined>((resolve) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", onAbort);
      shared.waiting--;
    };
    const onAbort = () => {
      leave();
      if (!shared.waiting && !shared.done) {
        if (catalogs.get(executable) === shared) catalogs.delete(executable);
        // The last reader stops the read and leaves once `agy models` has exited.
        shared.stop();
        void shared.models.then(() => resolve(undefined));
      } else resolve(undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void shared.models.then((models) => { if (!left) { leave(); resolve(models); } });
  });
}

/** The display name of agy's default model, from its settings (read only). */
export function agyDefaultModel(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const model = (JSON.parse(readFileSync(join(agyHome(env), ".gemini", "antigravity-cli", "settings.json"), "utf8")) as { model?: unknown }).model;
    return typeof model === "string" && model ? model : undefined;
  } catch { return undefined; }
}

/**
 * The `--model` / `--effort` flags for `options`, and a notice for each value agy does not list (Fixed decision 6): that
 * value is left out and agy uses its default. A variant slug names its effort and a model without variants has none, so
 * neither gets `--effort` (agy rejects both). Without a catalog the values go to agy as they are.
 */
export function agyModelArgs(options: BackendOptions, catalog: AgyModel[] | undefined, defaultName?: string):
  { args: string[]; notices: string[]; model?: string; effort?: string } {
  const notices: string[] = [];
  let { model, effort } = options;
  if (!catalog) {
    if (model && EFFORT_SUFFIX.test(model)) effort = undefined;
    return { args: [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])], notices,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  let family: AgyModel | undefined;
  if (model) {
    const variant = catalog.flatMap((item) => item.variants).find((item) => item.slug === model);
    if (variant) {
      if (effort && effort !== variant.effort) notices.push(`agy model "${model}" already names its effort; effort "${effort}" is not applied`);
      return { args: ["--model", model], notices, model, effort: variant.effort };
    }
    family = catalog.find((item) => item.slug === model);
    if (!family) {
      notices.push(`agy does not offer model "${model}"; it keeps its default (offered: ${catalog.map((item) => item.slug).join(", ")})`);
      model = undefined;
    }
  }
  family ??= model ? undefined : catalog.find((item) => item.name === defaultName || item.variants.some((variant) => variant.name === defaultName));
  if (effort && family && !family.efforts.includes(effort)) {
    notices.push(family.efforts.length ? `agy does not offer effort "${effort}" for ${family.slug}; it keeps its default (offered: ${family.efforts.join(", ")})`
      : `agy model ${family.slug} has no effort option; effort "${effort}" is not applied`);
    effort = undefined;
  }
  return { args: [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])], notices,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** `backend.mode` as agy's flags: `skip-permissions` approves every tool; any other value is agy's `--mode`. */
export function agyModeArgs(mode: string | undefined): string[] {
  if (!mode) return [];
  return mode === "skip-permissions" ? ["--dangerously-skip-permissions"] : ["--mode", mode];
}

// ---------- the agent file that carries the system prompt ----------

function agyHome(env: NodeJS.ProcessEnv): string {
  return (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
}

/**
 * Where Raw's agent files go: a plugin of agy's named `raw`, the one place agy 1.4.10 loads an agent from without a
 * change to its own config (`~/.gemini/config/agents` is not read). Files there are never deleted (Fixed decision 9).
 */
export function agyPluginRoot(env: NodeJS.ProcessEnv): string {
  return join(agyHome(env), ".gemini", "config", "plugins", "raw");
}

const PLUGIN_MANIFEST = `${JSON.stringify({ name: "raw", version: "1.0.0", description: "Agents Raw writes for its agy backend" })}\n`;

/** Writes `content` to `file` unless it exists: through a unique temporary name in the same directory, then a rename. */
function writeOnce(file: string, content: string): void {
  if (existsSync(file)) return;
  const staged = join(file, "..", `.${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, content);
    // Another Raw may have written the same name meanwhile; both wrote the same bytes.
    try { renameSync(staged, file); } catch (error) { if (!existsSync(file)) throw error; }
  } finally { rmSync(staged, { force: true }); }
}

/** The agent file for `prompt` and `tools`; its name is a digest of its content, so an unchanged agent reuses it. */
export function agyAgentFile(agentName: string, prompt: string, tools: readonly string[]): { name: string; content: string } {
  const body = `description: ${JSON.stringify(`Raw agent ${agentName}`)}\ntools: ${JSON.stringify(tools)}\n---\n${prompt}`;
  const name = `raw-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  return { name, content: `---\nname: ${name}\n${body}${prompt.endsWith("\n") ? "" : "\n"}` };
}

/** Writes the agent file if absent and returns the agent's name for `--agent`. */
export function writeAgyAgent(root: string, agentName: string, prompt: string, tools: readonly string[]): string {
  const { name, content } = agyAgentFile(agentName, prompt, tools);
  mkdirSync(join(root, "agents"), { recursive: true });
  writeOnce(join(root, "plugin.json"), PLUGIN_MANIFEST);
  writeOnce(join(root, "agents", `${name}.md`), content);
  return name;
}

// ---------- the runner ----------

/** The text agy gets for one turn: stream-json input carries text only, so an image becomes its placeholder. */
function inputText(input: UserInput): { text: string; images: boolean } {
  if (typeof input === "string") return { text: input, images: false };
  let images = false;
  const text = input.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") { images = true; return imagePlaceholderText(block); }
    return `${block.title ?? block.name} <${block.uri}>`;
  }).join("");
  return { text, images };
}

/**
 * Splits a byte stream into whole lines (UTF-8, without `\r`) holding at most `limit` characters of a line in progress: a
 * longer line is not a message, and is dropped up to its end, so the lines after it still come through.
 */
export class BoundedLines {
  private pending = "";
  private skipping = false;
  private readonly decoder = new StringDecoder("utf8");
  constructor(private readonly limit: number) {}
  /** Characters of the unfinished line held now. */
  get buffered(): number { return this.pending.length; }
  push(chunk: Buffer): string[] {
    const parts = (this.pending + this.decoder.write(chunk)).split("\n");
    this.pending = parts.pop()!;
    const lines: string[] = [];
    for (const line of parts) { if (!this.skipping) lines.push(line.replace(/\r$/, "")); this.skipping = false; }
    if (this.pending.length > this.limit) { this.pending = ""; this.skipping = true; }
    return lines;
  }
}

interface Binding { store: SessionStore; sessionId: string; owner: SessionOwner }

export interface AgyBackendProviderOptions {
  agentName: string;
  spec: BackendSpec;
  systemPrompt?: string;
  /** Whether the agent set a system prompt, also an empty one. */
  promptGiven?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  binding?: () => Binding | undefined;
  diagnostic?: (line: string) => void;
  /** Reads the catalog; `agy models` by default. */
  catalog?: (executable: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) => Promise<AgyModel[] | undefined>;
}

interface Launch { executable: string; agent?: string; tools: readonly string[]; catalog?: AgyModel[] | undefined; defaultName?: string }

/** How one agy process ended its turn. */
type Outcome = { ok: true; turn: ProviderTurn } | { ok: false; error: string; quiet: boolean };

/**
 * Runs the user's `agy` for one session runtime, one process per turn (`--print=` with stream-json on stdin and stdout),
 * continuing the conversation with `--conversation`. agy has no approval channel and no cancel message: a cancelled
 * turn stops the process tree.
 */
export class AgyBackendProvider implements ProviderAdapter, BackendProvider {
  readonly modelConfig: Readonly<ResolvedModelConfig>;
  private readonly profileDigest: string;
  private readonly env: NodeJS.ProcessEnv;
  private launch: Launch | undefined;
  private cliSessionId: string | undefined;
  private opened = false;
  /** Whether the baseline model and effort were checked against a catalog (stored ones were). */
  private checked = false;
  private uncheckedNoticed = false;
  private baseline: BackendOptions = {};
  private delivered: number | undefined;
  private override: BackendOptions | undefined;
  private readonly queuedNotices: string[] = [];
  /** The model the last turn ran (none: agy's default), whose efforts the dashboard lists; unset before a turn. */
  private turnModel: { model?: string } | undefined;
  private peer: LinePeer | undefined;
  private closed = false;
  private previous: Promise<void> = Promise.resolve();
  /** Ends a catalog read in progress when the runtime closes. */
  private readonly closing = new AbortController();
  private readonly unknownKinds = new Map<string, number>();
  readonly usedModel: string | undefined = undefined;
  readonly context: { used: number; size: number } | undefined = undefined;

  constructor(private readonly config: AgyBackendProviderOptions) {
    this.modelConfig = backendModelConfig(config.agentName, config.spec);
    this.profileDigest = backendProfileDigest(config.spec, config.systemPrompt);
    this.env = config.env ?? process.env;
  }

  /** The agy process of the turn in progress. */
  get pid(): number | undefined { return this.peer?.child.pid; }
  currentValue(key: keyof BackendOptions): string | undefined { return this.baseline[key]; }
  setTurnOverride(options: BackendOptions | undefined): void { this.override = options; }
  noticeNextTurn(messages: readonly string[]): void { this.queuedNotices.push(...messages); }
  get unknownUpdates(): ReadonlyMap<string, number> { return new Map(this.unknownKinds); }

  generate(request: ProviderRequest): Promise<ProviderTurn> {
    const turn = this.previous.then(() => this.runTurn(request));
    this.previous = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private async runTurn(request: ProviderRequest): Promise<ProviderTurn> {
    if (this.closed) throw new BackendError("backend_closed", "agy runtime is closed");
    if (request.signal?.aborted) throw new BackendError("aborted", "startup aborted");
    const notify = (message: string) => { if (!request.signal?.aborted) request.onExternal?.({ type: "notice", message }); };
    if (!request.signal?.aborted) for (const message of this.queuedNotices.splice(0)) notify(message);
    const override = this.override;
    this.override = undefined;
    let lastAnswer = request.messages.length - 1;
    while (lastAnswer >= 0 && request.messages[lastAnswer]!.role !== "assistant") lastAnswer--;
    const launch = await this.resolveLaunch(notify);
    await this.readCatalog(launch, request, notify);
    this.open(notify, lastAnswer >= 0);
    const delivered = this.delivered !== undefined && this.delivered <= request.messages.length ? this.delivered : 0;
    const fresh = request.messages.slice(Math.max(lastAnswer + 1, delivered))
      .filter((message): message is Extract<ModelMessage, { role: "user" }> => message.role === "user");
    if (!fresh.length) throw new BackendError("backend_error", "there is no new message to send");
    const parts = fresh.map((message) => inputText(message.content));
    if (parts.some((part) => part.images)) notify("agy does not accept images; each is sent as a short description");
    const text = parts.map((part) => part.text).join("\n\n");
    let turnModel = override?.model ?? this.baseline.model;
    let turnEffort = override?.effort ?? this.baseline.effort;
    const turnArgs = (): string[] => {
      const chosen = agyModelArgs({ ...(turnModel ? { model: turnModel } : {}), ...(turnEffort ? { effort: turnEffort } : {}) },
        launch.catalog, launch.defaultName);
      // The model the run uses after the catalog check (undefined: agy's default); the session's lists follow it.
      this.turnModel = { ...(chosen.model ? { model: chosen.model } : {}) };
      // The baseline is checked once a catalog is there; an override every turn.
      const checking = launch.catalog && !this.checked && !override?.model && !override?.effort;
      if (override?.model || override?.effort || checking) for (const notice of chosen.notices) notify(notice);
      if (checking) {
        this.checked = true;
        const { model: _model, effort: _effort, ...rest } = this.baseline;
        this.baseline = { ...rest, ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) };
      }
      const mode = override?.mode ?? this.baseline.mode;
      return ["--input-format", "stream-json", "--output-format", "stream-json",
        ...(launch.agent ? ["--agent", launch.agent, "--disable-slash-commands"] : []), ...chosen.args, ...agyModeArgs(mode),
        ...(this.cliSessionId ? ["--conversation", this.cliSessionId] : []), "--print="];
    };
    let args = turnArgs();
    // Recorded before sending, so a store failure ends the turn before agy has it.
    this.delivered = request.messages.length;
    this.saveExternal();
    let outcome = await this.runProcess(launch, args, text, request, notify);
    // A run agy refused before doing anything is run again without what it refused, once per reason.
    let retriedTools = false;
    let retriedModel = false;
    let retriedEffort = false;
    while (!outcome.ok && outcome.quiet) {
      const unknown = [...outcome.error.matchAll(/tool "([^"]+)" not found in registry/g)].map((match) => match[1]!)
        .filter((name) => launch.tools.includes(name));
      if (!retriedTools && launch.agent && unknown.length) {
        // agy fails a run on a tool name its executor does not resolve; the agent goes on without those tools.
        retriedTools = true;
        launch.tools = launch.tools.filter((name) => !unknown.includes(name));
        launch.agent = writeAgyAgent(agyPluginRoot(this.env), this.config.agentName, this.config.systemPrompt!, launch.tools);
        notify(`agy does not know the tool${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; the agent runs without ${unknown.length > 1 ? "them" : "it"}`);
      } else if (!retriedEffort && args.includes("--effort") && INVALID_EFFORT.test(outcome.error)) {
        // Without a catalog Raw could not check the values; agy names the one it refuses, and the turn runs without it.
        retriedEffort = true;
        notify(`agy does not offer effort "${turnEffort}"${turnModel ? ` for model "${turnModel}"` : ""}; it keeps its default`);
        if (!override?.effort) { const { effort: _effort, ...rest } = this.baseline; this.baseline = rest; }
        turnEffort = undefined;
      } else if (!retriedModel && args.includes("--model") && INVALID_MODEL.test(outcome.error)) {
        retriedModel = true;
        notify(`agy does not offer model "${turnModel}"; it keeps its default`);
        if (!override?.model) { const { model: _model, effort: _effort, ...rest } = this.baseline; this.baseline = rest; }
        turnModel = undefined;
        turnEffort = undefined;
      } else break;
      args = turnArgs();
      this.saveExternal();
      outcome = await this.runProcess(launch, args, text, request, notify);
    }
    if (!outcome.ok) throw new BackendError("backend_error", `agy: ${outcome.error}`);
    return outcome.turn;
  }

  /**
   * The catalog, read until one read succeeds; a read is bounded by the turn's `request_timeout_ms` and ends with a
   * cancel. Without it the configured model and effort go to agy unchecked, which the turn says once.
   */
  private async readCatalog(launch: Launch, request: ProviderRequest, notify: (message: string) => void): Promise<void> {
    if (launch.catalog) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // The read ends with the turn's cancel or the runtime's close; a read no other turn waits on is then stopped.
    const reading = new AbortController();
    const stop = () => reading.abort();
    this.closing.signal.addEventListener("abort", stop, { once: true });
    try {
      launch.catalog = await Promise.race([(this.config.catalog ?? agyCatalog)(launch.executable, this.env, request.timeoutMs, reading.signal),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { stop(); resolve(undefined); }, request.timeoutMs); }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => { reject(new BackendError("aborted", "startup aborted")); stop(); };
          if (request.signal?.aborted) onAbort();
          request.signal?.addEventListener("abort", onAbort, { once: true });
        })]);
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
      this.closing.signal.removeEventListener("abort", stop);
    }
    if (this.closed || request.signal?.aborted) throw new BackendError("aborted", "startup aborted");
    const { model, effort } = { ...this.config.spec, ...this.override };
    if (!launch.catalog && !this.uncheckedNoticed && (model || effort || this.baseline.model || this.baseline.effort)) {
      this.uncheckedNoticed = true;
      notify("agy models could not be read; model and effort go to agy unchecked");
    }
  }

  /** The executable, the agent file and the catalog, found once per runtime; the baseline is the agent's valid options. */
  private async resolveLaunch(notify: (message: string) => void): Promise<Launch> {
    if (this.launch) return this.launch;
    const { spec, systemPrompt } = this.config;
    const executable = findExecutable(spec.executable ?? "agy", this.env, this.config.cwd);
    if (!executable) throw new BackendError("backend_unavailable", `agy is not available: ${AGY_MISSING}`);
    const tools = spec.tools ?? AGY_DEFAULT_TOOLS;
    let agent: string | undefined;
    if (systemPrompt) {
      if (spec.systemPromptMode === "append") notify(AGY_APPEND);
      try { agent = writeAgyAgent(agyPluginRoot(this.env), this.config.agentName, systemPrompt, tools); }
      catch (error) { throw new BackendError("backend_unavailable", `agy is not available: cannot write the agent file: ${(error as Error).message}`); }
    } else if (this.config.promptGiven) notify(AGY_EMPTY_PROMPT);
    const defaultName = agyDefaultModel(this.env);
    const launch: Launch = { executable, tools, ...(agent ? { agent } : {}), ...(defaultName ? { defaultName } : {}) };
    this.launch = launch;
    return launch;
  }

  /** Continues the stored conversation when it is the same profile; otherwise the next process starts a new one. */
  private open(notify: (message: string) => void, hadTurns: boolean): void {
    if (this.opened) return;
    this.opened = true;
    const binding = this.config.binding?.();
    const stored = binding?.store.readExternal(binding.sessionId, binding.owner);
    if (stored && stored.kind === "agy" && stored.profileDigest === this.profileDigest) {
      this.cliSessionId = stored.cliSessionId;
      this.baseline = { ...stored.baseline };
      this.delivered = stored.delivered;
      this.checked = true;
      return;
    }
    const { model, effort, mode } = this.config.spec;
    this.baseline = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) };
    // What an earlier conversation of this session was sent, a cancelled turn's input too, is not sent to this one.
    this.delivered = stored?.delivered ?? this.delivered;
    if (hadTurns || stored) notify(FRESH);
  }

  private saveExternal(): void {
    const binding = this.config.binding?.();
    if (!binding || !this.cliSessionId) return;
    const external: ExternalSession = { kind: "agy", cliSessionId: this.cliSessionId, profileDigest: this.profileDigest, baseline: this.baseline,
      ...(this.delivered !== undefined ? { delivered: this.delivered } : {}),
      offered: offeredFromAgyCatalog(this.launch?.catalog, this.baseline, this.launch?.defaultName,
        this.turnModel ? this.turnModel.model : this.baseline.model) };
    binding.store.writeExternal(binding.sessionId, binding.owner, external);
  }

  /** One agy process for one turn: the input on stdin, events from stdout, until its `result`, exit, cancel or silence. */
  private async runProcess(launch: Launch, args: string[], text: string, request: ProviderRequest,
    notify: (message: string) => void): Promise<Outcome> {
    const mapper = new AgyEventMapper();
    let reply = "";
    let active = false;
    let usage: Record<string, number> | undefined;
    let result: Extract<AgyTurnEvent, { type: "result" }> | undefined;
    // What agy printed that is not stream-json, for an error message: its last bytes only, as the peer keeps stderr.
    let noise = "";
    let noiseDropped = false;
    const keepNoise = (line: string) => {
      noise += `${line}\n`;
      if (noise.length > DEFAULT_MAX_OUTPUT_BYTES) { noise = noise.slice(noise.length - DEFAULT_MAX_OUTPUT_BYTES); noiseDropped = true; }
    };
    const requested = this.cliSessionId;
    let settle!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => { settle = (error) => error ? reject(error) : resolve(); });
    let timer: NodeJS.Timeout | undefined;
    let paused = false;
    const arm = () => {
      clearTimeout(timer);
      if (paused) return;
      timer = setTimeout(() => settle(new BackendError("backend_unresponsive", `agy sent nothing for ${request.timeoutMs} ms`)), request.timeoutMs);
    };
    const dispatch = (event: AgyTurnEvent) => {
      if (paused) return;
      if (event.type === "conversation") this.conversation(event.id, requested, notify);
      else if (event.type === "result") { result = event; usage = event.usage; settle(); }
      else if (event.type === "text") { active = true; reply += event.text; request.onTextDelta?.(event.text); }
      else if (event.type === "reasoning") request.onReasoningDelta?.(event.text);
      else if (event.type === "unknown") this.reportUnknown(event.kind);
      else if (event.type === "tool_start" || event.type === "tool_result" || event.type === "notice") { active = true; request.onExternal?.(event); }
    };
    const warning = (line: string) => {
      const match = /^warning:\s*(.+)$/i.exec(line.trim());
      if (match) notify(`agy: ${match[1]}`);
    };
    const onLine = (line: string) => {
      arm();
      if (!line.trim()) return;
      // A failure here (the store refusing the conversation id, a host callback) ends the turn, not the process.
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch { warning(line); keepNoise(line); return; }
        for (const event of mapper.map(parsed)) dispatch(event);
      } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    };
    let peer: LinePeer;
    try { peer = spawnLinePeer({ command: launch.executable, args, cwd: this.config.cwd, env: this.env, maxFrameBytes: MAX_FRAME_BYTES, onLine }); }
    catch (error) { throw new BackendError("backend_unavailable", `agy could not start: ${(error as Error).message}`); }
    this.peer = peer;
    const stderrLines = new BoundedLines(DEFAULT_MAX_OUTPUT_BYTES);
    peer.child.stderr.on("data", (chunk: Buffer) => {
      try { for (const line of stderrLines.push(chunk)) warning(line); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    peer.spawnFailure.catch((error: unknown) => settle(new BackendError("backend_unavailable", `agy could not start: ${(error as Error).message}`)));
    peer.frameFailure.catch(() => settle(new BackendError("backend_frame_too_large", `agy sent a message longer than ${MAX_FRAME_BYTES} bytes`)));
    peer.child.once("exit", (code, signal) => {
      // The last lines may still be on their way; the exit counts once stdout has ended or a moment has passed.
      const report = () => {
        if (result) return;
        const tail = [`${noiseDropped ? "[output truncated]\n" : ""}${noise}`.trim(), peer.stderrTail().trim()].filter(Boolean).join("\n");
        settle(new BackendError("backend_exited", `agy exited (${signal ?? `code ${code}`}) without a result${tail ? `: ${tail}` : ""}`));
      };
      if (peer.child.stdout.readableEnded) report();
      else { const wait = setTimeout(report, EXIT_WAIT_MS); peer.child.once("close", () => { clearTimeout(wait); report(); }); }
    });
    const onAbort = () => settle(new BackendError("aborted", "turn cancelled"));
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    peer.child.stdin.on("error", () => {});
    peer.child.stdin.end(`${JSON.stringify({ event: "user", message: { role: "user", content: text } })}\n`);
    arm();
    try {
      await done;
      for (const event of mapper.closeOpen("backend_error", "agy did not report a result for this call")) dispatch(event);
      // agy saves the conversation after its result and then exits (about 0.9 s with agy 1.4.10); the next turn continues
      // it, so agy gets as long as the turn's silence limit. One still running then, or cancelled meanwhile, is stopped.
      clearTimeout(timer);
      let onCancel: (() => void) | undefined;
      const exited = await Promise.race([peer.waitForExit(request.timeoutMs),
        new Promise<boolean>((resolve) => { onCancel = () => resolve(false); request.signal?.addEventListener("abort", onCancel, { once: true }); })]);
      if (onCancel) request.signal?.removeEventListener("abort", onCancel);
      if (!exited && !request.signal?.aborted) notify(`agy did not exit within ${request.timeoutMs} ms of its answer and was stopped; the next turn may not see this one`);
      await peer.stop(0).catch(() => {});
      const ended = result!;
      if (!ended.ok) return { ok: false, error: ended.error, quiet: !active };
      if (!reply && ended.response) { reply = ended.response; request.onTextDelta?.(reply); }
      return { ok: true, turn: { text: reply, toolCalls: [], finishReason: "end_turn", ...(usage ? { usage } : {}) } };
    } catch (error) {
      const code = error instanceof BackendError && error.code === "aborted" ? "cancelled" : "backend_error";
      for (const event of mapper.closeOpen(code, code === "cancelled" ? "cancelled" : (error as Error).message)) dispatch(event);
      paused = true;
      await peer.stop(0).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      paused = true;
      request.signal?.removeEventListener("abort", onAbort);
      if (this.peer === peer) this.peer = undefined;
    }
  }

  /** The conversation agy runs this turn; a requested one it no longer has becomes a new one. */
  private conversation(id: string, requested: string | undefined, notify: (message: string) => void): void {
    if (this.cliSessionId === id) return;
    if (requested && requested !== id) notify(FRESH);
    this.cliSessionId = id;
    this.saveExternal();
  }

  private reportUnknown(kind: string): void {
    const seen = this.unknownKinds.get(kind) ?? 0;
    this.unknownKinds.set(kind, seen + 1);
    if (!seen) (this.config.diagnostic ?? ((line) => process.stderr.write(line)))(`raw: agy sent unknown update ${kind}\n`);
  }

  /** Stops the turn's process, if any; the agent file and the stored conversation stay. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    const peer = this.peer;
    this.peer = undefined;
    if (peer) await peer.stop(0).catch(() => {});
  }
}
