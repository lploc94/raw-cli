import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createAgent, type AgentSession, type RunResult } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { createRuntimeTools } from "./tools/plugins/runtime.js";
import { renderStoredHistory } from "./sessions/display.js";
import { runSessionMaintenance } from "./sessions/maintenance.js";
import type { SessionStore, SessionSummary } from "./sessions/store.js";

import { toolArguments } from "./sessions/display.js";
import { TerminalRenderer } from "./terminal/renderer.js";

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

function statusCode(result: RunResult, quiet = false): number {
  if (result.status === "completed") return 0;
  if (result.status === "cancelled") return 130;
  if (result.status === "max_steps") { if (!quiet) process.stderr.write("raw: maximum steps reached\n"); return 3; }
  if (result.code === "approval_required") { if (!quiet) process.stderr.write("raw: tool approval required by caller\n"); return 2; }
  if (!quiet) process.stderr.write(`raw: ${result.code ?? "agent_error"}\n`);
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
  const createSavedSession = (title: string) => store.createSession({ cwd, title,
    agentName: runtime.modelConfig!.agentName, configPath: runtime.configPath, modelId: runtime.modelConfig!.model,
    provider: runtime.modelConfig!.provider, method: runtime.modelConfig!.method,
    ...(runtime.modelConfig!.baseUrl ? { endpoint: runtime.modelConfig!.baseUrl } : {}),
    systemPrompt: runtime.systemPrompt });
  const createRuntimeAgent = (id: string) => createAgent({ provider, registry: tools.registry, whitelist: tools.selectedNames,
    toolSourceDigest: tools.toolSourceDigest, selectedSkills: tools.skills,
    cwd, system: runtime.systemPrompt, maxSteps: runtime.maxSteps, maxOutputBytes: runtime.maxOutputBytes,
    requestTimeoutMs: runtime.requestTimeoutMs, autoApprove: runtime.autoApprove, compact: runtime.compact,
    persistence: { store, sessionId: id, surface: "cli" },
    ...(process.stdin.isTTY && lines ? { approve: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => askPermission(lines, name, args, signal, tools.registry.canonicalIdentity(name), currentRenderer) } : {}) });
  let session: AgentSession;
  let record: SessionSummary;
  try {
    record = selected ?? createSavedSession(task?.trim().replace(/\s+/g, " ").slice(0, 80) || "New session");
    session = createRuntimeAgent(record.id);
  } catch (error) { rl?.close(); await tools.mcp.close(); throw error; }
  const interrupt = () => {
    currentRenderer?.beforeInput();
    if (session.abort()) { if (!currentRenderer?.rich) process.stderr.write("\nraw: cancelled\n"); return; }
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
      currentRenderer = new TerminalRenderer(session, runtime, cwd, true);
      const result = await textRun(session, task, currentRenderer);
      const code = statusCode(result, currentRenderer.rich);
      if (result.status === "completed") {
        const stats = session.stats();
        const usage: string[] = [];
        if (stats.requests > 0 && stats.inputCoverage === stats.requests && stats.outputCoverage === stats.requests) {
          usage.push(`${stats.inputTokensKnown} input / ${stats.outputTokensKnown} output tokens`);
        } else {
          if (stats.requests > 0 && stats.inputCoverage === stats.requests) usage.push(`${stats.inputTokensKnown} input tokens`);
          if (stats.requests > 0 && stats.outputCoverage === stats.requests) usage.push(`${stats.outputTokensKnown} output tokens`);
        }
        if (stats.requests > 0 && stats.cacheRatioCoverage === stats.requests) usage.push(`${stats.cacheReadTokensKnown} cache-read tokens`);
        if (usage.length) process.stderr.write(`raw: session usage: ${stats.requests} request${stats.requests === 1 ? "" : "s"}, ${usage.join(", ")}\n`);
        const contextTokens = session.estimatedContextTokens();
        const contextWindow = runtime.modelConfig!.contextWindow;
        process.stderr.write(contextWindow === undefined
          ? `raw: context: ~${contextTokens} tokens (window unknown)\n`
          : `raw: context: ~${contextTokens} / ${contextWindow} tokens (${(contextTokens / contextWindow * 100).toFixed(1)}% used)\n`);
        process.stderr.write(`raw: continue: raw --resume ${record.id} "query"\n`);
      }
      return code;
    }
    if (!rl || !lines) throw new Error("interactive input unavailable");
    new TerminalRenderer(session, runtime, cwd, true).start();
    if (selected) for (const item of store.getSessionHistory({ sessionId: selected.id }).items) {
      process.stdout.write(`${renderStoredHistory(item)}\n`);
    }
    while (!closed) {
      try { runSessionMaintenance(store, { sweepOrphans: false, reclaim: false }); }
      catch { process.stderr.write("raw: session maintenance deferred\n"); }
      process.stdout.write("> ");
      const line = await lines.next();
      if (line === undefined) break;
      if (closed) break;
      if (!line.trim()) continue;
      if (line === "/exit") break;
      if (line === "/clear") {
        await session.close();
        session = createRuntimeAgent(createSavedSession("New session").id);
        process.stderr.write("raw: conversation cleared\n");
        continue;
      }
      if (line === "/stats") { process.stderr.write(`${JSON.stringify(session.stats())}\n`); continue; }
      if (line === "/compact") {
        try {
          const modelConfig = runtime.resolveCompactModelConfig();
          process.stderr.write(`raw: compacting with ${modelConfig.agentName}\n`);
          const result = await session.compact({ provider: createProvider(modelConfig),
            keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens });
          process.stderr.write(`raw: compact ${result.status}\n`);
        } catch { process.stderr.write("raw: compaction failed\n"); }
        continue;
      }
      currentRenderer = new TerminalRenderer(session, runtime, cwd, false);
      const result = await textRun(session, line, currentRenderer);
      if (result.code === "approval_required" && !process.stdin.isTTY) return statusCode(result, currentRenderer.rich);
      if (result.status !== "completed" && result.status !== "cancelled") statusCode(result, currentRenderer.rich);
      currentRenderer = undefined;
    }
    return cancelledWhileIdle ? 130 : 0;
  } finally {
    rl?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", onTerm);
    await session.close();
    await tools.mcp.close();
  }
}
