import { spawn } from "node:child_process";
import { HookError, type HookExecution, type HookRequest, type SelectedHook } from "./contract.js";

const MAX_IO = 65536;
const MAX_INPUT = 1024 * 1024;

export async function runHook(hook: SelectedHook, request: HookRequest,
  options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<HookExecution> {
  const fail = (code: string): never => { throw new HookError(code, hook.id); };
  if (options.signal?.aborted) fail("aborted");
  const input = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(input) > MAX_INPUT) fail("input_too_large");
  const started = performance.now();
  const posix = process.platform !== "win32";
  const child = spawn(hook.command, [...hook.args], { cwd: request.cwd, env: options.env ?? process.env,
    shell: false, detached: posix, stdio: ["pipe", "pipe", "pipe"] });
  let failure: string | undefined;
  let code: number | null = null;
  let size = 0;
  const chunks: Buffer[] = [];
  let escalation: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (!posix) {
      const tree = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      tree.on("error", () => { try { child.kill(); } catch { /* exited */ } });
      return;
    }
    try { process.kill(-child.pid, signal); } catch { /* exited */ }
  };
  const stop = (reason: string) => {
    if (failure) return;
    failure = reason;
    child.stdin.destroy();
    signalChild("SIGTERM");
    escalation = setTimeout(() => signalChild("SIGKILL"), 500);
    watchdog = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 1500);
  };
  child.on("error", () => stop("spawn"));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (!failure && error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stop("stdin");
  });
  child.on("close", (exit) => { code = exit; finish(); });
  for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]] as const) {
    stream.on("error", () => stop("io"));
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_IO) stop("output_too_large");
      else if (keep && !failure) chunks.push(chunk);
    });
  }
  const onAbort = () => stop("aborted");
  const deadline = setTimeout(() => stop("timeout"), Math.min(hook.timeoutMs, options.timeoutMs ?? hook.timeoutMs));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    if (!failure) child.stdin.end(input);
    await completed;
  } finally {
    clearTimeout(deadline); clearTimeout(escalation); clearTimeout(watchdog);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
  if (failure) fail(failure);
  if (code !== 0 && code !== 2) fail("exit");
  const gate = request.event === "UserPromptSubmit" || request.event === "PreToolUse";
  if (code === 2 && !gate) fail("exit");
  let value: Record<string, unknown> = {};
  if (chunks.length) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { if (code !== 2) fail("invalid_output"); }
    if (parsed !== undefined) {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { if (code !== 2) fail("invalid_output"); }
      else value = parsed as Record<string, unknown>;
    }
  }
  if (Object.keys(value).some((key) => !["decision", "reason", "message"].includes(key))) fail("invalid_output");
  if (value.decision !== undefined && (!gate || (value.decision !== "continue" && value.decision !== "deny"))) fail("invalid_output");
  if (value.reason !== undefined && (typeof value.reason !== "string" || Buffer.byteLength(value.reason) > 1024)) fail("invalid_output");
  if (value.message !== undefined && (typeof value.message !== "string" || Buffer.byteLength(value.message) > 512)) fail("invalid_output");
  const decision = code === 2 || value.decision === "deny" ? "deny" : "continue";
  return { decision, ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    durationMs: Math.round(performance.now() - started) };
}
