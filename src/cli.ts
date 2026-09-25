import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createAgent, type AgentSession, type RunEvent, type RunResult } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { createRuntimeTools } from "./tools/plugins/runtime.js";
import { renderStoredHistory } from "./sessions/display.js";
import { runSessionMaintenance } from "./sessions/maintenance.js";
import type { SessionStore, SessionSummary } from "./sessions/store.js";

export { resultPreview } from "./sessions/display.js";
import { resultPreview, toolArguments } from "./sessions/display.js";

function textRun(session: AgentSession, task: string): Promise<RunResult> {
  let wrote = false;
  let endedWithNewline = false;
  let thinkingOpen = false;
  let thinkingEndedWithNewline = false;
  const pendingCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const color = Boolean(process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
  const style = (value: string, code: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const finishThinking = () => {
    if (thinkingOpen && !thinkingEndedWithNewline) process.stderr.write("\n");
    thinkingOpen = false;
  };
  const finishTextLine = () => {
    if (wrote && !endedWithNewline) {
      process.stdout.write("\n");
      endedWithNewline = true;
    }
  };
  const show = (event: RunEvent) => {
    if (event.type === "text_delta") {
      finishThinking();
      process.stdout.write(event.text);
      wrote ||= event.text.length > 0;
      if (event.text.length) endedWithNewline = event.text.endsWith("\n");
    } else if (event.type === "reasoning_delta" && event.text) {
      finishTextLine();
      if (!thinkingOpen) process.stderr.write(`raw: ${style("thinking", "2")}\n`);
      process.stderr.write(style(event.text, "2"));
      thinkingOpen = true;
      thinkingEndedWithNewline = event.text.endsWith("\n");
    } else if (event.type === "tool_call") {
      pendingCalls.set(event.id, { name: event.name, arguments: event.arguments });
    } else if (event.type === "tool_start") {
      pendingCalls.delete(event.id);
      finishTextLine();
      finishThinking();
      const label = color ? style(`⚙ ${event.name}`, "1;36") : event.name;
      const args = ` ${style(toolArguments(event.name, event.arguments), "2")}`;
      process.stderr.write(`raw: ${label}${args}\n`);
    }
    else if (event.type === "tool_result") {
      finishTextLine();
      finishThinking();
      const pending = pendingCalls.get(event.id);
      if (pending) {
        pendingCalls.delete(event.id);
        const args = pending.name === "write_file" && !Array.isArray(pending.arguments.operations)
          ? JSON.stringify({ argument_keys: Object.keys(pending.arguments) })
          : toolArguments(pending.name, pending.arguments);
        process.stderr.write(`raw: ${style(`⚠ ${pending.name}`, "1;33")} ${style(args, "2")}\n`);
      }
      const result = event.result;
      const failed = result.isError || (typeof result.exitCode === "number" && result.exitCode !== 0);
      const meta = [
        ...(typeof result.exitCode === "number" ? [`exit ${result.exitCode}`] : []),
        ...(result.code ? [result.code] : []),
        ...(result.truncated ? ["model output capped"] : []),
      ];
      const preview = resultPreview(event.name, result);
      const label = `${failed ? "✗" : "↳"} ${event.name} result${meta.length ? ` (${meta.join(", ")})` : ""}${preview ? "" : " (empty)"}`;
      process.stderr.write(`raw: ${style(label, failed ? "1;31" : "2")}\n`);
      if (preview) process.stderr.write(`${style(preview, "2")}\n`);
    } else if (event.type === "compact_start") {
      finishTextLine();
      process.stderr.write(`raw: compacting context (${event.estimatedTokens} estimated input tokens)\n`);
    } else if (event.type === "compact_end") {
      finishTextLine();
      process.stderr.write(`raw: compact ${event.result.status}\n`);
    }
  };
  return session.run(task, show).then((result) => {
    finishThinking();
    if (!wrote && result.text) {
      process.stdout.write(result.text);
      endedWithNewline = result.text.endsWith("\n");
      wrote = true;
    }
    if (wrote && !endedWithNewline) process.stdout.write("\n");
    return result;
  });
}

function statusCode(result: RunResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "cancelled") return 130;
  if (result.status === "max_steps") { process.stderr.write("raw: maximum steps reached\n"); return 3; }
  if (result.code === "approval_required") { process.stderr.write("raw: tool approval required by caller\n"); return 2; }
  process.stderr.write(`raw: ${result.code ?? "agent_error"}\n`);
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

async function askPermission(lines: ReturnType<typeof lineQueue>, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const mark = lines.mark();
  process.stderr.write(`raw: allow ${name} ${toolArguments(name, args, true)}? [y/N] `);
  const answer = await lines.nextAfter(mark, signal);
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim());
}

export async function runCli(runtime: RuntimeConfig, task: string | undefined,
  store: SessionStore, selected?: SessionSummary): Promise<number> {
  if (!runtime.profile) throw new Error("provider and model are required");
  const cwd = selected?.cwd ?? process.cwd();
  const provider = createProvider(runtime.profile);
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
  const createSavedSession = (title: string) => store.createSession({ cwd, title,
    profileName: runtime.profile!.name, configPath: runtime.configPath, modelId: runtime.profile!.model,
    provider: runtime.profile!.provider, method: runtime.profile!.method,
    ...(runtime.profile!.baseUrl ? { endpoint: runtime.profile!.baseUrl } : {}),
    systemPrompt: runtime.systemPrompt });
  const createRuntimeAgent = (id: string) => createAgent({ provider, registry: tools.registry, whitelist: tools.selectedNames,
    toolSourceDigest: tools.toolSourceDigest, selectedSkills: tools.skills,
    cwd, system: runtime.systemPrompt, maxSteps: runtime.maxSteps, maxOutputBytes: runtime.maxOutputBytes,
    requestTimeoutMs: runtime.requestTimeoutMs, autoApprove: runtime.autoApprove, compact: runtime.compact,
    persistence: { store, sessionId: id, surface: "cli" },
    ...(process.stdin.isTTY && lines ? { approve: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => askPermission(lines, name, args, signal) } : {}) });
  let session: AgentSession;
  let record: SessionSummary;
  try {
    record = selected ?? createSavedSession(task?.trim().replace(/\s+/g, " ").slice(0, 80) || "New session");
    session = createRuntimeAgent(record.id);
  } catch (error) { rl?.close(); await tools.mcp.close(); throw error; }
  const interrupt = () => {
    if (session.abort()) { process.stderr.write("\nraw: cancelled\n"); return; }
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
      const result = await textRun(session, task);
      const code = statusCode(result);
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
        const contextWindow = runtime.profile!.contextWindow;
        process.stderr.write(contextWindow === undefined
          ? `raw: context: ~${contextTokens} tokens (window unknown)\n`
          : `raw: context: ~${contextTokens} / ${contextWindow} tokens (${(contextTokens / contextWindow * 100).toFixed(1)}% used)\n`);
        process.stderr.write(`raw: continue: raw --resume ${record.id} "query"\n`);
      }
      return code;
    }
    if (!rl || !lines) throw new Error("interactive input unavailable");
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
          const profile = runtime.resolveCompactProfile();
          process.stderr.write(`raw: compacting with ${profile.name}\n`);
          const result = await session.compact({ provider: createProvider(profile),
            keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens });
          process.stderr.write(`raw: compact ${result.status}\n`);
        } catch { process.stderr.write("raw: compaction failed\n"); }
        continue;
      }
      const result = await textRun(session, line);
      if (result.code === "approval_required" && !process.stdin.isTTY) return statusCode(result);
      if (result.status !== "completed" && result.status !== "cancelled") statusCode(result);
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
