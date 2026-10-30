import { ProcessSupervisor } from "./processes/supervisor.js";
import { terminalInteractionAdapter } from "./interactions/terminal.js";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { RunResult } from "./agent.js";
import { BACKEND_LABELS, backendCompactTrigger, backendContextWindow } from "./backends/config.js";
import { createSessionAgent, sessionIdentity, type SessionAgentFactory } from "./backends/factory.js";
import type { BackgroundEvent, BackgroundWork, CliTask, SessionAgent } from "./backends/types.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { createRuntimeTools } from "./tools/plugins/runtime.js";
import { renderTerminalHistory } from "./terminal/history.js";
import { terminalCapabilities } from "./terminal/options.js";
import { formatResumeCommand, formatStats, formatTurnFooter } from "./terminal/footer.js";
import { effectiveInputBudget } from "./llm/context.js";
import { decor, icon, paint } from "./terminal/theme.js";
import { runSessionMaintenance } from "./sessions/maintenance.js";
import type { SessionStore, SessionSummary } from "./sessions/store.js";

import { toolArguments } from "./sessions/display.js";
import { TerminalRenderer } from "./terminal/renderer.js";
import { safeTerminalText } from "./terminal/safe.js";
import type { ToolApprovalRequest } from "./tools/primitives.js";
import { panelTitle, renderPanelsText, selectPanels } from "./panels/render.js";
import { effectiveOutputTokens } from "./llm/output.js";
import { onShutdown } from "./platform/signals.js";

async function textRun(session: SessionAgent, task: string, renderer: TerminalRenderer): Promise<RunResult> {
  renderer.start();
  try {
    const result = await session.run(task, renderer.event);
    renderer.finish(result);
    return result;
  } catch (error) {
    renderer.beforeInput();
    throw error;
  }
}

const liveTasks = (background: BackgroundWork): CliTask[] => background.tasks().filter((task) => task.state === "running" || task.state === "paused");

function statusCode(result: RunResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "cancelled") return 130;
  if (result.status === "max_steps") return 3;
  if (result.code === "approval_required") return 2;
  return 1;
}

function lineQueue(rl: ReadlineInterface): {
  next(signal?: AbortSignal): Promise<string | undefined>;
  nextAfter(mark: number, signal?: AbortSignal): Promise<string | undefined>;
  mark(): number;
} {
  const buffered: Array<{ id: number; line: string }> = [];
  let closed = false;
  let lastId = 0;
  let waiting: { after: number; deliver: (line: string | undefined) => void } | undefined;
  rl.on("line", (line) => {
    const entry = { id: ++lastId, line };
    if (waiting && entry.id > waiting.after) { const deliver = waiting.deliver; waiting = undefined; deliver(line); }
    else buffered.push(entry);
  });
  rl.on("close", () => { closed = true; if (waiting) { const deliver = waiting.deliver; waiting = undefined; deliver(undefined); } });
  const take = (after: number, signal?: AbortSignal): Promise<string | undefined> => {
    if (signal?.aborted) return Promise.resolve(undefined);
    const index = buffered.findIndex((entry) => entry.id > after);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]!.line);
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => { if (waiting?.deliver === deliver) waiting = undefined; deliver(undefined); };
      const deliver = (line: string | undefined) => { signal?.removeEventListener("abort", onAbort); resolve(line); };
      waiting = { after, deliver };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  return { next: (signal) => take(0, signal), nextAfter: take, mark: () => lastId };
}

async function askPermission(lines: ReturnType<typeof lineQueue>, request: ToolApprovalRequest, renderer?: TerminalRenderer): Promise<boolean> {
  const { name, arguments: args, signal, identity } = request;
  if (signal?.aborted) return false;
  const mark = lines.mark();
  process.stderr.write(renderer?.approvalPrompt(request)
    ?? `raw: allow ${safeTerminalText(`${request.title}  ${request.summary}`)}? (${name} ${safeTerminalText(toolArguments(name, args, true, identity))}) [y/N] `);
  const answer = await lines.nextAfter(mark, signal);
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim());
}

export interface RunCliDeps {
  /** Builds the session agent; tests inject a fake that is not Raw's own loop. */
  createSessionAgent?: SessionAgentFactory;
}

export async function runCli(runtime: RuntimeConfig, task: string | undefined,
  store: SessionStore, selected?: SessionSummary, deps: RunCliDeps = {}): Promise<number> {
  const factory = deps.createSessionAgent ?? createSessionAgent;
  if (!deps.createSessionAgent && !runtime.backend && !runtime.modelConfig) throw new Error("provider and model are required");
  const cwd = selected?.cwd ?? process.cwd();
  const startupController = new AbortController();
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; startupController.abort(); };
  process.on("SIGINT", cancelStartup);
  const offStartup = onShutdown(cancelStartup);
  let tools;
  try {
    tools = await createRuntimeTools({ runtime, cwd, signal: startupController.signal });
  } catch (error) {
    if (startupCancelled) return 130;
    throw error;
  } finally {
    process.off("SIGINT", cancelStartup);
    offStartup();
  }
  if (startupCancelled) { await tools.mcp.close(); return 130; }
  const rl = task === undefined || process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    : undefined;
  const lines = rl ? lineQueue(rl) : undefined;
  let closed = false;
  let cancelledWhileIdle = false;
  let currentRenderer: TerminalRenderer | undefined;
  let lastTurn: { elapsedMs: number; firstTextMs?: number } | undefined;
  let sessionResumable = true;
  const caps = terminalCapabilities(Boolean(process.stderr.isTTY), process.env, runtime.ui);
  const stdoutCaps = terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui);
  for (const warning of tools.warnings) {
    process.stderr.write(`${paint("warning", icon("attention", runtime.ui, caps), runtime.ui, caps)} ${safeTerminalText(warning)}\n`);
  }
  const formatFooter = (result: RunResult, renderer: TerminalRenderer, id: string, resumable: boolean, repl = false) => {
    const context = session.contextUsage();
    const window = runtime.modelConfig?.contextWindow ?? (runtime.backend ? backendContextWindow(runtime.backend) : undefined) ?? context.window;
    const trigger = runtime.compact.triggerTokens ?? (runtime.backend ? backendCompactTrigger(runtime.backend)?.tokens : undefined);
    const reserve = runtime.modelConfig ? effectiveOutputTokens(runtime.modelConfig) : 0;
    return formatTurnFooter({ status: result.status, ...(result.code ? { code: result.code } : {}),
      elapsedMs: renderer.elapsedMs, startedToolCalls: renderer.startedToolCalls, notRunToolCalls: renderer.notRunToolCalls,
      stats: session.stats(), contextTokens: context.tokens, contextReported: context.source === "provider",
      ...(window === undefined ? {} : { contextWindow: window, inputBudget: effectiveInputBudget(window, reserve) }),
      ...(trigger === undefined ? {} : { compactTrigger: trigger }),
      sessionId: id, resumable, repl, ui: runtime.ui, caps });
  };
  const createSavedSession = (title: string) => store.createSession({ cwd, title, ...sessionIdentity(runtime),
    configPath: runtime.configPath, systemPrompt: runtime.systemPrompt });
  const processes = new ProcessSupervisor({ store });
  const createRuntimeAgent = (id: string) => factory({ runtime, tools, cwd, host: {
    processes, persistence: { store, sessionId: id, surface: "cli" },
    ...(process.stdin.isTTY && lines ? { interactionAdapter: (request, signal) => {
      currentRenderer?.beforeInput();
      return terminalInteractionAdapter(lines, text => process.stderr.write(text))(request, signal);
    }, approve: (request: ToolApprovalRequest) => {
      if (request.effects) process.stderr.write(`raw: intended effects ${JSON.stringify(request.effects)}\n`);
      return askPermission(lines, request, currentRenderer);
    } } : {}) } });
  const hookEvent = (event: import("./agent.js").RunEvent) => {
    if (currentRenderer) currentRenderer.event(event);
    else if (event.type === "hook_event") process.stderr.write(`${decor(safeTerminalText(`raw: hook ${event.id} ${event.event} ${event.outcome}${event.message ? ` · ${event.message}` : ""}`), caps)}\n`);
  };
  let session: SessionAgent;
  let record: SessionSummary;
  try {
    record = selected ?? createSavedSession(task?.trim().replace(/\s+/g, " ").slice(0, 80) || "New session");
    session = createRuntimeAgent(record.id);
    await session.start(selected ? "resume" : "create", selected && task === undefined ? undefined : hookEvent);
  } catch (error) { rl?.close(); try { await processes.close(); } finally { await tools.mcp.close(); } throw error; }
  // A one-shot run waiting for the CLI's background work: Ctrl-C ends the wait (cli-background-work).
  let backgroundWait: AbortController | undefined;
  const interrupt = () => {
    currentRenderer?.beforeInput();
    if (session.abort()) { backgroundWait?.abort(); return; }
    if (backgroundWait) { backgroundWait.abort(); return; }
    cancelledWhileIdle = true;
    rl?.close();
  };
  const cliLabel = runtime.backend ? BACKEND_LABELS[runtime.backend.kind] : "the CLI";
  const reportLost = (event: Extract<BackgroundEvent, { type: "exited" }>) => process.stderr.write(
    `raw: ${cliLabel} exited; ${event.lost.length} background task(s) were lost: ${event.lost.map((name) => safeTerminalText(name)).join(", ")}\n`);
  /** Says which of the CLI's tasks closing the session stops. */
  const reportStopped = () => {
    const stopped = session.background ? liveTasks(session.background) : [];
    if (stopped.length) process.stderr.write(`raw: stopped ${stopped.length} background task(s) of ${cliLabel}: ${stopped.map((task) => safeTerminalText(task.name)).join(", ")}\n`);
  };
  /** Runs the CLI turn waiting now, rendered like a turn of the REPL. */
  const cliTurn = async (background: BackgroundWork): Promise<RunResult> => {
    currentRenderer = new TerminalRenderer(session, runtime, cwd, false);
    currentRenderer.start();
    const result = await background.runCliTurn(currentRenderer.event);
    currentRenderer.finish(result);
    process.stderr.write(formatFooter(result, currentRenderer, record.id, false, true));
    currentRenderer = undefined;
    return result;
  };
  /**
   * After a one-shot turn: while the CLI has background work, its turns run as they come; Ctrl-C stops the tasks (130),
   * and an adapter that exits ends the run (1). The status is that of the last turn run.
   */
  const awaitBackground = async (background: BackgroundWork, last: RunResult): Promise<number> => {
    const live = liveTasks(background);
    if (live.length) process.stderr.write(`raw: waiting for ${live.length} background task(s) of ${cliLabel}; Ctrl-C stops them\n`);
    const wait = new AbortController();
    backgroundWait = wait;
    let exited: Extract<BackgroundEvent, { type: "exited" }> | undefined;
    let wake: (() => void) | undefined;
    const off = background.onEvent((event) => { if (event.type === "exited") exited = event; wake?.(); });
    try {
      while (true) {
        if (exited) { reportLost(exited); return 1; }
        if (wait.signal.aborted) {
          const stopping = liveTasks(background);
          await background.stopAll();
          process.stderr.write(`raw: stopped ${stopping.length} background task(s)\n`);
          return 130;
        }
        if (background.cliTurnNote() !== undefined) { last = await cliTurn(background); continue; }
        if (!background.hasWork()) return statusCode(last);
        await new Promise<void>((resolve) => {
          wake = resolve;
          wait.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = undefined;
      }
    } finally { off(); backgroundWait = undefined; }
  };
  const onClose = () => {
    closed = true;
    session.abort();
  };
  const onTerm = () => { closed = true; session.abort(); backgroundWait?.abort(); rl?.close(); };
  process.on("SIGINT", interrupt);
  const offTerm = onShutdown(onTerm);
  rl?.on("SIGINT", interrupt);
  rl?.on("close", onClose);
  try {
    if (task !== undefined) {
      currentRenderer = new TerminalRenderer(session, runtime, cwd, true, Boolean(selected));
      const result = await textRun(session, task, currentRenderer);
      let resumable = result.code !== "persistence_error";
      if (resumable) try { resumable = store.getSession(record.id) !== undefined; } catch { resumable = false; }
      process.stderr.write(formatFooter(result, currentRenderer, record.id, resumable));
      currentRenderer = undefined;
      return session.background && result.status !== "cancelled" ? await awaitBackground(session.background, result) : statusCode(result);
    }
    if (!rl || !lines) throw new Error("interactive input unavailable");
    // An adapter that exits between turns takes its tasks with it; the REPL says so when it happens.
    let offExited: (() => void) | undefined;
    const watchExit = () => {
      offExited?.();
      offExited = session.background?.onEvent((event) => {
        if (event.type !== "exited" || !event.lost.length) return;
        currentRenderer?.beforeInput();
        reportLost(event);
      });
    };
    watchExit();
    new TerminalRenderer(session, runtime, cwd, true, Boolean(selected)).start();
    if (selected) for (const item of store.getSessionHistory({ sessionId: selected.id }).items) {
      process.stdout.write(renderTerminalHistory(item, runtime.ui,
        terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui), process.stdout.columns || 80));
    }
    while (!closed) {
      try { runSessionMaintenance(store, { sweepOrphans: false, reclaim: false }); }
      catch { process.stderr.write("raw: session maintenance deferred\n"); }
      // A turn the CLI takes on its own runs while Raw waits for a line, and the prompt is shown again after it.
      const background = session.background;
      if (background?.cliTurnNote() !== undefined) { await cliTurn(background); continue; }
      process.stdout.write(`${paint("accent", icon("user", runtime.ui, stdoutCaps), runtime.ui, stdoutCaps)} `);
      const idle = new AbortController();
      const off = background?.onEvent((event) => { if (event.type === "cli_turn") idle.abort(); });
      let line: string | undefined;
      try { line = await lines.next(idle.signal); } finally { off?.(); }
      if (line === undefined && idle.signal.aborted && !closed) { process.stdout.write("\n"); continue; }
      if (line === undefined) break;
      if (closed) break;
      if (!line.trim()) continue;
      if (line === "/exit") break;
      if (line === "/clear") {
        reportStopped();
        offExited?.();
        await session.close(hookEvent);
        record = createSavedSession("New session");
        session = createRuntimeAgent(record.id);
        await session.start("create", hookEvent);
        lastTurn = undefined;
        sessionResumable = true;
        watchExit();
        process.stderr.write("raw: conversation cleared\n");
        new TerminalRenderer(session, runtime, cwd, true).start();
        continue;
      }
      if (line === "/panels" || line.startsWith("/panels ")) {
        const words = line.split(/\s+/).slice(1);
        const all = words.includes("--all");
        const id = words.find((word) => word !== "--all");
        const found = selectPanels(store.listSessionPanels(record.id), { ...(all ? { all: true } : {}), ...(id ? { id } : {}) });
        process.stderr.write(!found ? `raw: unknown panel ${safeTerminalText(id ?? "")}\n`
          : found.length ? `${decor(safeTerminalText(renderPanelsText(found.map((panel) => ({ title: panelTitle(panel), document: panel.document, closed: panel.closed })))), caps)}\n` : "raw: no open panels\n");
        continue;
      }
      if (line === "/stats") { process.stderr.write(formatStats(session.stats(), runtime.ui, caps, lastTurn)); continue; }
      if (line === "/compact") {
        if (runtime.backend) { process.stderr.write("raw: /compact is not supported by this backend; the CLI keeps its own context\n"); continue; }
        try {
          const modelConfig = runtime.resolveCompactModelConfig();
          process.stderr.write(`${paint("thinking", icon("thinking", runtime.ui, caps), runtime.ui, caps)} Compacting with ${modelConfig.agentName}\n`);
          const result = await session.compact({ provider: createProvider(modelConfig),
            keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens,
            ...(runtime.compact.maxOutputTokensDefaulted ? { maxOutputTokensDefaulted: true } : {}),
            ...(runtime.compact.keepRecentTokens !== undefined ? { keepRecentTokens: runtime.compact.keepRecentTokens } : {}),
            ...(runtime.compact.instructions ? { instructions: runtime.compact.instructions } : {}) });
          process.stderr.write(`${paint(result.status === "compacted" ? "success" : "warning",
            icon(result.status === "compacted" ? "success" : "attention", runtime.ui, caps), runtime.ui, caps)} Compact ${result.status}\n`);
        } catch { process.stderr.write("raw: compaction failed\n"); }
        continue;
      }
      currentRenderer = new TerminalRenderer(session, runtime, cwd, false);
      const result = await textRun(session, line, currentRenderer);
      lastTurn = { elapsedMs: currentRenderer.elapsedMs,
        ...(currentRenderer.firstTextMs === undefined ? {} : { firstTextMs: currentRenderer.firstTextMs }) };
      if (result.code === "persistence_error") sessionResumable = false;
      process.stderr.write(formatFooter(result, currentRenderer, record.id, false, true));
      if (result.code === "approval_required" && !process.stdin.isTTY) return statusCode(result);
      currentRenderer = undefined;
    }
    offExited?.();
    reportStopped();
    if (sessionResumable && store.getSession(record.id)) process.stderr.write(formatResumeCommand(record.id, runtime.ui, caps));
    return cancelledWhileIdle ? 130 : 0;
  } finally {
    rl?.close();
    process.off("SIGINT", interrupt);
    offTerm();
    await session.close(hookEvent);
    try { await processes.close(); } finally { await tools.mcp.close(); }
  }
}
