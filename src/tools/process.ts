import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolResult } from "./types.js";
import { errorResult, utf8Prefix } from "./results.js";

export interface BashOptions {
  onOutput?: (channel: "stdout" | "stderr", text: string) => void;
  env?: NodeJS.ProcessEnv;
  command: string;
  cwd: string;
  maxOutputBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  bashPath?: string;
}

/** Shared shell spawn/group primitive; lifecycle and output policy belong to its caller. */
export function spawnShell(options: { command: string; cwd: string; env?: NodeJS.ProcessEnv; bashPath?: string }, platform: NodeJS.Platform = process.platform) {
  return spawn(options.bashPath ?? process.env.RAW_BASH_PATH ?? "bash", ["-c", options.command], {
    cwd: options.cwd, ...(options.env ? { env: options.env } : {}), stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32",
  });
}
export function signalShellGroup(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try { if (child.pid) process.kill(platform !== "win32" ? -child.pid : child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export async function runBash(options: BashOptions): Promise<ToolResult> {
  if (options.signal?.aborted) return errorResult("aborted", "bash aborted before execution");
  const timeoutMs = options.timeoutMs ?? 120000;
  const child = spawnShell(options);
  let observedBytes = 0;
  let retainedBytes = 0;
  let truncated = false;
  let saturated = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;
  let stdout = "";
  let stderr = "";
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let reapTimer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let resolveCancelled!: () => void;
  const cancellationWatchdog = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  let escalation: Promise<void> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => signalShellGroup(child, signal);
  const stop = (reason: "abort" | "timeout") => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise<void>((resolve) => {
      killTimer = setTimeout(() => { signalGroup("SIGKILL"); resolve(); }, 500);
    });
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveCancelled();
    }, 700);
  };
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  deadline = setTimeout(() => stop("timeout"), timeoutMs);
  const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
    observedBytes += chunk.length;
    const text = (channel === "stdout" ? outDecoder : errDecoder).write(chunk);
    try { options.onOutput?.(channel, text); } catch { /* observers never own execution */ }
    if (saturated) return;
    const prefix = utf8Prefix(text, options.maxOutputBytes - retainedBytes);
    retainedBytes += prefix.bytes;
    if (channel === "stdout") stdout += prefix.text;
    else stderr += prefix.text;
    if (prefix.truncated) { truncated = true; saturated = true; }
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  let exited: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  const exitedPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => { exited = { code, signal }; resolve(); });
  });
  const closedPromise = new Promise<void>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", () => resolve());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed" as const), cancellationWatchdog.then(() => "watchdog" as const)]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise<void>((resolve) => { reapTimer = setTimeout(resolve, 1300); })]);
    if (reapTimer) clearTimeout(reapTimer);
  }
  if (deadline) clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  if (escalation) await escalation;
  if (drainTimer) clearTimeout(drainTimer);
  for (const [channel, tail] of [["stdout", outDecoder.end()], ["stderr", errDecoder.end()]] as const) {
    if (!tail) continue;
    try { options.onOutput?.(channel, tail); } catch { /* observers never own execution */ }
    if (!saturated) {
      const prefix = utf8Prefix(tail, options.maxOutputBytes - retainedBytes);
      retainedBytes += prefix.bytes;
      if (channel === "stdout") stdout += prefix.text;
      else stderr += prefix.text;
      if (prefix.truncated) truncated = true;
    }
  }
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`);
  const content: ToolResult["content"] = [];
  if (stdout) content.push({ type: "text", channel: "stdout", text: stdout });
  if (stderr) content.push({ type: "text", channel: "stderr", text: stderr });
  return {
    isError: aborted || timedOut,
    ...(aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {}),
    content,
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    truncated: truncated || observedBytes > retainedBytes,
    retainedBytes,
    observedBytes,
  };
}
