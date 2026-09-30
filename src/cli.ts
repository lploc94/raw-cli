import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createAgent, type AgentSession, type RunResult } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { createRuntimeTools } from "./tools/plugins/runtime.js";
import { runtimeAgentOptions } from "./sessions/runtime.js";
import { renderTerminalHistory } from "./terminal/history.js";
import { terminalCapabilities } from "./terminal/options.js";
import { formatResumeCommand, formatStats, formatTurnFooter } from "./terminal/footer.js";
import { effectiveInputBudget } from "./llm/context.js";
import { icon, paint } from "./terminal/theme.js";
import { runSessionMaintenance } from "./sessions/maintenance.js";
import type { SessionStore, SessionSummary } from "./sessions/store.js";

import { toolArguments } from "./sessions/display.js";
import { TerminalRenderer } from "./terminal/renderer.js";
import { safeTerminalText } from "./terminal/safe.js";
import { panelTitle, renderPanelsText, selectPanels } from "./panels/render.js";

async function textRun(session: AgentSession, task: string, renderer: TerminalRenderer): Promise<RunResult> {
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

async function askPermission(lines: ReturnType<typeof lineQueue>, name: string, args: Record<string, unknown>, signal?: AbortSignal, identity?: string, renderer?: TerminalRenderer): Promise<boolean> {
  if (signal?.aborted) return false;
  const mark = lines.mark();
  process.stderr.write(renderer?.approvalPrompt(name, args, identity)
    ?? `raw: allow ${name} ${toolArguments(name, args, true, identity)}? [y/N] `);
  const answer = await lines.nextAfter(mark, signal);
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim());
}

export async function runCli(runtime: RuntimeConfig, task: string | undefined,
  store: SessionStore, selected?: SessionSummary): Promise<number> {
  if (!runtime.modelConfig) throw new Error("provider and model are required");
  const cwd = selected?.cwd ?? process.cwd();
  const provider = createProvider(runtime.modelConfig);
  const startupController = new AbortController();
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; startupController.abort(); };
  process.on("SIGINT", cancelStartup);
  process.on("SIGTERM", cancelStartup);
  let tools;
  try {
    tools = await createRuntimeTools({ runtime, cwd, signal: startupController.signal });
  } catch (error) {
    if (startupCancelled) return 130;
    throw error;
  } finally {
    process.off("SIGINT", cancelStartup);
    process.off("SIGTERM", cancelStartup);
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
  const formatFooter = (result: RunResult, renderer: TerminalRenderer, id: string, resumable: boolean, repl = false) => {
    const window = runtime.modelConfig!.contextWindow;
    const reserve = runtime.modelConfig!.request?.maxOutputTokens ?? runtime.modelConfig!.maxOutputTokens ?? 1024;
    const context = session.contextUsage();
    return formatTurnFooter({ status: result.status, ...(result.code ? { code: result.code } : {}),
      elapsedMs: renderer.elapsedMs, startedToolCalls: renderer.startedToolCalls, notRunToolCalls: renderer.notRunToolCalls,
      stats: session.stats(), contextTokens: context.tokens, contextReported: context.source === "provider",
      ...(window === undefined ? {} : { contextWindow: window, inputBudget: effectiveInputBudget(window, reserve) }),
      ...(runtime.compact.triggerTokens === undefined ? {} : { compactTrigger: runtime.compact.triggerTokens }),
      sessionId: id, resumable, repl, ui: runtime.ui, caps });
  };
  const createSavedSession = (title: string) => store.createSession({ cwd, title,
    agentName: runtime.modelConfig!.agentName, configPath: runtime.configPath, modelId: runtime.modelConfig!.model,
    provider: runtime.modelConfig!.provider, method: runtime.modelConfig!.method,
    ...(runtime.modelConfig!.baseUrl ? { endpoint: runtime.modelConfig!.baseUrl } : {}),
    systemPrompt: runtime.systemPrompt });
  const createRuntimeAgent = (id: string) => createAgent({ ...runtimeAgentOptions(runtime, tools, provider, cwd),
    persistence: { store, sessionId: id, surface: "cli" },
    ...(process.stdin.isTTY && lines ? { approve: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => askPermission(lines, name, args, signal, tools.registry.canonicalIdentity(name), currentRenderer) } : {}) });
  const hookEvent = (event: import("./agent.js").RunEvent) => {
    if (currentRenderer) currentRenderer.event(event);
    else if (event.type === "hook_event") process.stderr.write(`${safeTerminalText(`raw: hook ${event.id} ${event.event} ${event.outcome}${event.message ? ` · ${event.message}` : ""}`)}\n`);
  };
  let session: AgentSession;
  let record: SessionSummary;
  try {
    record = selected ?? createSavedSession(task?.trim().replace(/\s+/g, " ").slice(0, 80) || "New session");
    session = createRuntimeAgent(record.id);
    await session.start(selected ? "resume" : "create", selected && task === undefined ? undefined : hookEvent);
  } catch (error) { rl?.close(); await tools.mcp.close(); throw error; }
  const interrupt = () => {
    currentRenderer?.beforeInput();
    if (session.abort()) return;
    cancelledWhileIdle = true;
    rl?.close();
  };
  const onClose = () => {
    closed = true;
    session.abort();
  };
  const onTerm = () => { closed = true; session.abort(); rl?.close(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", onTerm);
  rl?.on("SIGINT", interrupt);
  rl?.on("close", onClose);
  try {
    if (task !== undefined) {
      currentRenderer = new TerminalRenderer(session, runtime, cwd, true, Boolean(selected));
      const result = await textRun(session, task, currentRenderer);
      let resumable = result.code !== "persistence_error";
      if (resumable) try { resumable = store.getSession(record.id) !== undefined; } catch { resumable = false; }
      process.stderr.write(formatFooter(result, currentRenderer, record.id, resumable));
      return statusCode(result);
    }
    if (!rl || !lines) throw new Error("interactive input unavailable");
    new TerminalRenderer(session, runtime, cwd, true, Boolean(selected)).start();
    if (selected) for (const item of store.getSessionHistory({ sessionId: selected.id }).items) {
      process.stdout.write(renderTerminalHistory(item, runtime.ui,
        terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui), process.stdout.columns || 80));
    }
    while (!closed) {
      try { runSessionMaintenance(store, { sweepOrphans: false, reclaim: false }); }
      catch { process.stderr.write("raw: session maintenance deferred\n"); }
      process.stdout.write(`${paint("accent", icon("user", runtime.ui, stdoutCaps), runtime.ui, stdoutCaps)} `);
      const line = await lines.next();
      if (line === undefined) break;
      if (closed) break;
      if (!line.trim()) continue;
      if (line === "/exit") break;
      if (line === "/clear") {
        await session.close(hookEvent);
        record = createSavedSession("New session");
        session = createRuntimeAgent(record.id);
        await session.start("create", hookEvent);
        lastTurn = undefined;
        sessionResumable = true;
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
          : found.length ? `${safeTerminalText(renderPanelsText(found.map((panel) => ({ title: panelTitle(panel), document: panel.document, closed: panel.closed }))))}\n` : "raw: no open panels\n");
        continue;
      }
      if (line === "/stats") { process.stderr.write(formatStats(session.stats(), runtime.ui, caps, lastTurn)); continue; }
      if (line === "/compact") {
        try {
          const modelConfig = runtime.resolveCompactModelConfig();
          process.stderr.write(`${paint("thinking", icon("thinking", runtime.ui, caps), runtime.ui, caps)} Compacting with ${modelConfig.agentName}\n`);
          const result = await session.compact({ provider: createProvider(modelConfig),
            keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens });
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
    if (sessionResumable && store.getSession(record.id)) process.stderr.write(formatResumeCommand(record.id, runtime.ui, caps));
    return cancelledWhileIdle ? 130 : 0;
  } finally {
    rl?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", onTerm);
    await session.close(hookEvent);
    await tools.mcp.close();
  }
}
