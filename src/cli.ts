import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createAgent, type AgentSession, type RunEvent, type RunResult } from "./agent.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { connectMcpServers, type McpServerConfig } from "./tools/mcp-client.js";
import { createToolRegistry } from "./tools/registry.js";

function textRun(session: AgentSession, task: string): Promise<RunResult> {
  let wrote = false;
  let endedWithNewline = false;
  const show = (event: RunEvent) => {
    if (event.type === "text_delta") {
      process.stdout.write(event.text);
      wrote ||= event.text.length > 0;
      if (event.text.length) endedWithNewline = event.text.endsWith("\n");
    } else if (event.type === "tool_start") process.stderr.write(`raw: ${event.name}\n`);
    else if (event.type === "tool_result" && event.result.isError) process.stderr.write(`raw: ${event.name}: ${event.result.code ?? "tool_error"}\n`);
  };
  return session.run(task, show).then((result) => {
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
  process.stderr.write(`raw: allow ${name} ${JSON.stringify(args)}? [y/N] `);
  const answer = await lines.nextAfter(mark, signal);
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim());
}

export async function runCli(runtime: RuntimeConfig, task: string | undefined, mcpServers: Readonly<Record<string, McpServerConfig>>): Promise<number> {
  if (!runtime.profile) throw new Error("provider and model are required");
  const cwd = process.cwd();
  const provider = createProvider(runtime.profile);
  const startupController = new AbortController();
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; startupController.abort(); };
  process.on("SIGINT", cancelStartup);
  process.on("SIGTERM", cancelStartup);
  let mcp;
  try {
    mcp = await connectMcpServers({ cwd, servers: mcpServers, registry: createToolRegistry(runtime.toolRules, runtime.profile?.vision === true),
      timeoutMs: runtime.requestTimeoutMs, signal: startupController.signal });
  } catch (error) {
    if (startupCancelled) return 130;
    throw error;
  } finally {
    process.off("SIGINT", cancelStartup);
    process.off("SIGTERM", cancelStartup);
  }
  if (startupCancelled) { await mcp.close(); return 130; }
  const rl = task === undefined || process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    : undefined;
  const lines = rl ? lineQueue(rl) : undefined;
  let closed = false;
  let cancelledWhileIdle = false;
  const session = createAgent({ provider, registry: mcp.registry,
    cwd, system: runtime.systemPrompt, maxSteps: runtime.maxSteps, maxOutputBytes: runtime.maxOutputBytes,
    requestTimeoutMs: runtime.requestTimeoutMs, autoApprove: runtime.autoApprove,
    ...(process.stdin.isTTY && lines ? { approve: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => askPermission(lines, name, args, signal) } : {}) });
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
    if (task !== undefined) return statusCode(await textRun(session, task));
    if (!rl || !lines) throw new Error("interactive input unavailable");
    while (!closed) {
      process.stdout.write("> ");
      const line = await lines.next();
      if (line === undefined) break;
      if (closed) break;
      if (!line.trim()) continue;
      if (line === "/exit") break;
      if (line === "/clear") { session.clear(); process.stderr.write("raw: conversation cleared\n"); continue; }
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
    await mcp.close();
  }
}
