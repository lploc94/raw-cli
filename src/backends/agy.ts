import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_FRAME_BYTES } from "../acp/transport.js";
import { spawnLinePeer, type LinePeer } from "../acp/peer.js";
import { imagePlaceholderText, type ModelMessage, type ProviderAdapter, type ProviderRequest, type ProviderTurn, type ResolvedModelConfig,
  type UserInput } from "../llm/types.js";
import { prepareSpawn } from "../platform/windows.js";
import type { ExternalSession, SessionOwner, SessionStore } from "../sessions/store.js";
import { BackendError, backendModelConfig, backendProfileDigest, type BackendOptions, type BackendProvider } from "./acp-agent.js";
import { findExecutable } from "./adapters.js";
import { AgyEventMapper, type AgyTurnEvent } from "./agy-events.js";
import type { BackendSpec } from "./config.js";

export const AGY_MISSING = "Install Antigravity (`agy`) and log in, or set backend.executable";
export const AGY_APPEND = "agy cannot add to its own system prompt; the agent's prompt replaces it";
export const AGY_EMPTY_PROMPT = "agy cannot run with an empty system prompt; it keeps its own";
const FRESH = "This agy conversation starts here; it does not see earlier turns";

/**
 * The tools a Raw agent file lists by default: the names agy 1.4.10 reports in `init.tools` that its executor also
 * resolves. agy has no wildcard (`tools: ["*"]` fails) and fails a run on any name it does not resolve, so a name a
 * later agy drops is removed and the turn retried (`AgyBackendProvider`).
 */
export const AGY_DEFAULT_TOOLS: readonly string[] = Object.freeze(["ask_custom_permission", "ask_permission", "ask_question",
  "define_subagent", "find_by_name", "finish", "generate_image", "grep_search", "invoke_subagent", "list_dir", "list_plugin_accounts",
  "manage_subagents", "manage_task", "multi_replace_file_content", "notebook_edit", "read_url_content", "replace_file_content",
  "run_command", "run_workflow", "schedule", "search_marketplace", "search_web", "send_message", "view_file", "wait", "write_to_file"]);

/** How long `agy models` may take. */
const CATALOG_TIMEOUT_MS = 15000;
/** How long agy may take to exit after its result, while it saves the conversation. */
const EXIT_GRACE_MS = 2000;
/** How long a finished stdout waits for the exit to be reported, and the reverse. */
const EXIT_WAIT_MS = 1000;
/** Lines of agy's stdout that are not stream-json, kept for an error message. */
const NOISE_LINES = 20;

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

const catalogs = new Map<string, Promise<AgyModel[] | undefined>>();

/** The catalog of the agy at `executable`, read once per process; undefined when `agy models` cannot be read. */
export function agyCatalog(executable: string, env: NodeJS.ProcessEnv): Promise<AgyModel[] | undefined> {
  let catalog = catalogs.get(executable);
  if (!catalog) {
    catalog = new Promise((resolve) => {
      const prepared = prepareSpawn(executable, ["models"], { cwd: process.cwd(), env });
      if (!prepared.ok) { resolve(undefined); return; }
      execFile(prepared.file, prepared.args, { env, encoding: "utf8", timeout: CATALOG_TIMEOUT_MS, windowsHide: true,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) },
      (error, stdout) => resolve(error ? undefined : parseAgyCatalog(stdout)));
    });
    catalogs.set(executable, catalog);
  }
  return catalog;
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
  catalog?: (executable: string, env: NodeJS.ProcessEnv) => Promise<AgyModel[] | undefined>;
}

interface Launch { executable: string; agent?: string; tools: readonly string[]; catalog: AgyModel[] | undefined; defaultName?: string }

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
  private baseline: BackendOptions = {};
  private delivered: number | undefined;
  private override: BackendOptions | undefined;
  private peer: LinePeer | undefined;
  private closed = false;
  private previous: Promise<void> = Promise.resolve();
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
    const override = this.override;
    this.override = undefined;
    let lastAnswer = request.messages.length - 1;
    while (lastAnswer >= 0 && request.messages[lastAnswer]!.role !== "assistant") lastAnswer--;
    const launch = await this.resolveLaunch(notify);
    this.open(notify, lastAnswer >= 0);
    const delivered = this.delivered !== undefined && this.delivered <= request.messages.length ? this.delivered : 0;
    const fresh = request.messages.slice(Math.max(lastAnswer + 1, delivered))
      .filter((message): message is Extract<ModelMessage, { role: "user" }> => message.role === "user");
    if (!fresh.length) throw new BackendError("backend_error", "there is no new message to send");
    const parts = fresh.map((message) => inputText(message.content));
    if (parts.some((part) => part.images)) notify("agy does not accept images; each is sent as a short description");
    const text = parts.map((part) => part.text).join("\n\n");
    const turnArgs = (): string[] => {
      const chosen = agyModelArgs({ ...(override?.model ?? this.baseline.model ? { model: override?.model ?? this.baseline.model } : {}),
        ...(override?.effort ?? this.baseline.effort ? { effort: override?.effort ?? this.baseline.effort } : {}) }, launch.catalog, launch.defaultName);
      if (override) for (const notice of chosen.notices) notify(notice);
      const mode = override?.mode ?? this.baseline.mode;
      return ["--input-format", "stream-json", "--output-format", "stream-json",
        ...(launch.agent ? ["--agent", launch.agent, "--disable-slash-commands"] : []), ...chosen.args, ...agyModeArgs(mode),
        ...(this.cliSessionId ? ["--conversation", this.cliSessionId] : []), "--print="];
    };
    // Recorded before sending, so a store failure ends the turn before agy has it.
    this.delivered = request.messages.length;
    this.saveExternal();
    let outcome = await this.runProcess(launch, turnArgs(), text, request, notify);
    if (!outcome.ok && outcome.quiet && launch.agent) {
      // agy fails a run on a tool name its executor does not resolve; the agent goes on without those tools, once.
      const unknown = [...outcome.error.matchAll(/tool "([^"]+)" not found in registry/g)].map((match) => match[1]!)
        .filter((name) => launch.tools.includes(name));
      if (unknown.length) {
        launch.tools = launch.tools.filter((name) => !unknown.includes(name));
        launch.agent = writeAgyAgent(agyPluginRoot(this.env), this.config.agentName, this.config.systemPrompt!, launch.tools);
        notify(`agy does not know the tool${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; the agent runs without ${unknown.length > 1 ? "them" : "it"}`);
        outcome = await this.runProcess(launch, turnArgs(), text, request, notify);
      }
    }
    if (!outcome.ok) throw new BackendError("backend_error", `agy: ${outcome.error}`);
    return outcome.turn;
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
    const catalog = await (this.config.catalog ?? agyCatalog)(executable, this.env);
    const defaultName = agyDefaultModel(this.env);
    const launch: Launch = { executable, tools, catalog, ...(agent ? { agent } : {}), ...(defaultName ? { defaultName } : {}) };
    if (this.closed) throw new BackendError("aborted", "startup aborted");
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
      return;
    }
    const chosen = agyModelArgs({ ...(this.config.spec.model ? { model: this.config.spec.model } : {}),
      ...(this.config.spec.effort ? { effort: this.config.spec.effort } : {}) }, this.launch!.catalog, this.launch!.defaultName);
    for (const notice of chosen.notices) notify(notice);
    this.baseline = { ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(this.config.spec.mode ? { mode: this.config.spec.mode } : {}) };
    // What an earlier conversation of this session was sent, a cancelled turn's input too, is not sent to this one.
    this.delivered = stored?.delivered ?? this.delivered;
    if (hadTurns || stored) notify(FRESH);
  }

  private saveExternal(): void {
    const binding = this.config.binding?.();
    if (!binding || !this.cliSessionId) return;
    const external: ExternalSession = { kind: "agy", cliSessionId: this.cliSessionId, profileDigest: this.profileDigest, baseline: this.baseline,
      ...(this.delivered !== undefined ? { delivered: this.delivered } : {}) };
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
    const noise: string[] = [];
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
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch {
        warning(line);
        noise.push(line);
        if (noise.length > NOISE_LINES) noise.shift();
        return;
      }
      for (const event of mapper.map(parsed)) dispatch(event);
    };
    let peer: LinePeer;
    try { peer = spawnLinePeer({ command: launch.executable, args, cwd: this.config.cwd, env: this.env, maxFrameBytes: MAX_FRAME_BYTES, onLine }); }
    catch (error) { throw new BackendError("backend_unavailable", `agy could not start: ${(error as Error).message}`); }
    this.peer = peer;
    let stderrLine = "";
    peer.child.stderr.on("data", (chunk: Buffer) => {
      const lines = (stderrLine + chunk.toString("utf8")).split("\n");
      stderrLine = lines.pop()!;
      for (const line of lines) warning(line);
    });
    peer.spawnFailure.catch((error: unknown) => settle(new BackendError("backend_unavailable", `agy could not start: ${(error as Error).message}`)));
    peer.frameFailure.catch(() => settle(new BackendError("backend_frame_too_large", `agy sent a message longer than ${MAX_FRAME_BYTES} bytes`)));
    peer.child.once("exit", (code, signal) => {
      // The last lines may still be on their way; the exit counts once stdout has ended or a moment has passed.
      const report = () => {
        if (result) return;
        const tail = [...noise, peer.stderrTail().trim()].filter(Boolean).join("\n").trim();
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
      // Waits for agy to finish saving the conversation before the next turn continues it.
      await peer.stop(EXIT_GRACE_MS).catch(() => {});
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
    const peer = this.peer;
    this.peer = undefined;
    if (peer) await peer.stop(0).catch(() => {});
  }
}
