import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolResult } from "./types.js";
import { elideMiddle, elideParts, errorResult, utf8Prefix } from "./results.js";
import { OutputSpill, savedLabel } from "./spill.js";

/** One channel's start and a rolling window of its end; the middle of an oversized stream is dropped. */
class ChannelCapture {
  private head = "";
  private headBytes = 0;
  private tail: string[] = [];
  private tailBytes = 0;
  total = 0;
  dropped = false;
  constructor(private readonly headCap: number, private readonly tailCap: number) {}
  push(text: string): void {
    if (!text) return;
    this.total += Buffer.byteLength(text);
    let rest = text;
    if (this.headBytes < this.headCap) {
      const prefix = utf8Prefix(rest, this.headCap - this.headBytes);
      this.head += prefix.text;
      this.headBytes += prefix.bytes;
      rest = rest.slice(prefix.text.length);
      if (!rest) return;
    }
    this.tail.push(rest);
    this.tailBytes += Buffer.byteLength(rest);
    while (this.tail.length > 1 && this.tailBytes - Buffer.byteLength(this.tail[0]!) >= this.tailCap) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift()!);
      this.dropped = true;
    }
  }
  /** Whole text when nothing was dropped and it fits; otherwise start + marker + end within `limit`. */
  text(limit: number, fullOutputPath?: string): { text: string; bytes: number; truncated: boolean } {
    const tail = this.tail.join("");
    if (!this.dropped) return elideMiddle(this.head + tail, limit, fullOutputPath);
    return elideParts(this.head, tail, this.total, limit, fullOutputPath);
  }
}

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
  return (await runBashDetailed(options)).result;
}

/** Output of a finished command rebuilt for a smaller byte budget, for callers whose framing adds overhead. */
/** Rebuilds both channels for `limit` bytes; omission markers name `saved`, the label of the full copy. */
export type BashRender = (limit: number, saved?: string) => { stdout: string; stderr: string; truncated: boolean };

export async function runBashDetailed(options: BashOptions): Promise<{ result: ToolResult; render?: BashRender }> {
  if (options.signal?.aborted) return { result: errorResult("aborted", "bash aborted before execution") };
  const timeoutMs = options.timeoutMs ?? 120000;
  const child = spawnShell(options);
  let observedBytes = 0;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;
  const max = Math.max(0, options.maxOutputBytes);
  const captures = { stdout: new ChannelCapture(Math.floor(max / 5), max), stderr: new ChannelCapture(Math.floor(max / 5), max) };
  // Output stays in memory until it exceeds the budget; from then on the complete stream is saved for the model to read.
  let pending: Buffer[] = [];
  let spill: OutputSpill | undefined;
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
    captures[channel].push(text);
    if (spill) spill.write(chunk);
    else {
      pending.push(chunk);
      if (observedBytes > max) {
        spill = new OutputSpill("bash");
        for (const buffered of pending) spill.write(buffered);
        pending = [];
      }
    }
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
    captures[channel].push(tail);
  }
  spill?.close();
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return { result: errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`) };
  const render: BashRender = (limit, fullOutputPath = savedLabel(spill?.path, spill?.capped)) => {
    // A channel smaller than half the budget keeps all of it; the larger channel gets the rest.
    const small = captures.stdout.total <= captures.stderr.total ? "stdout" : "stderr";
    const smallBudget = Math.min(captures[small].total, Math.floor(limit / 2));
    const largeBudget = limit - smallBudget;
    const out = captures.stdout.text(small === "stdout" ? smallBudget : largeBudget, fullOutputPath);
    const err = captures.stderr.text(small === "stderr" ? smallBudget : largeBudget, fullOutputPath);
    return { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  };
  const { stdout, stderr, truncated } = render(max);
  const retainedBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  const content: ToolResult["content"] = [];
  if (stdout) content.push({ type: "text", channel: "stdout", text: stdout });
  if (stderr) content.push({ type: "text", channel: "stderr", text: stderr });
  return { render, result: {
    isError: aborted || timedOut,
    ...(aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {}),
    content,
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    truncated,
    retainedBytes,
    observedBytes,
    ...(truncated && spill?.path ? { fullOutputPath: spill.path, ...(spill.capped ? { fullOutputCapped: true } : {}) } : {}),
  } };
}
