import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { prepareSpawn, terminateTree } from "../platform/windows.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../tools/results.js";

/** A child process that writes newline-delimited messages on stdout, and owns everything it starts. */
export interface LinePeer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly jobbed: boolean;
  /** Rejects when the process could not be started. */
  readonly spawnFailure: Promise<never>;
  /** Rejects (code `frame_too_large`) when the child writes one line longer than `maxFrameBytes`; the tree is then stopped. */
  readonly frameFailure: Promise<never>;
  exited(): boolean;
  /** The last bytes the child wrote to stderr, with a marker when older bytes were dropped. */
  stderrTail(): string;
  /** Signals the child's whole process group (POSIX) or stops its whole tree (Windows, where every signal is a stop). */
  signal(signal: NodeJS.Signals): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
  /** Ends stdin, waits `graceMs`, then stops the tree with SIGTERM and SIGKILL; throws when the child outlives both. */
  stop(graceMs: number): Promise<void>;
}

/** A child process that speaks newline-delimited JSON-RPC on stdio. */
export interface AcpPeer extends LinePeer {
  readonly stream: ReturnType<typeof ndJsonStream>;
}

/** How long the rest of a stopped child's group may take to exit after SIGTERM. */
const GROUP_GRACE_MS = 1000;

export interface AcpPeerOptions { command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv; stderrBytes?: number;
  maxFrameBytes?: number }

/**
 * Starts `command` as its own process group on POSIX (signalled with a negative pid, as `signalShellGroup` does) and
 * inside a job on Windows, so stopping it also stops whatever it started.
 */
export function spawnAcpPeer(options: AcpPeerOptions): AcpPeer {
  let stream!: ReturnType<typeof ndJsonStream>;
  const peer = spawnPeer(options, (guard, child) => {
    stream = ndJsonStream(Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(guard) as unknown as ReadableStream<Uint8Array>);
  });
  return { ...peer, stream };
}

/**
 * Starts `command` like `spawnAcpPeer`, for a child whose stdout is not JSON-RPC: each complete line (without its
 * newline, decoded as UTF-8) goes to `onLine`, and the last unterminated one when stdout ends.
 */
export function spawnLinePeer(options: AcpPeerOptions & { onLine: (line: string) => void }): LinePeer {
  return spawnPeer(options, (guard) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    guard.on("data", (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split("\n");
      pending = lines.pop()!;
      for (const line of lines) options.onLine(line.replace(/\r$/, ""));
    });
    guard.on("end", () => { const rest = pending + decoder.end(); pending = ""; if (rest) options.onLine(rest.replace(/\r$/, "")); });
  });
}

function spawnPeer(options: AcpPeerOptions, consume: (guard: Transform, child: ChildProcessWithoutNullStreams) => void): LinePeer {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // On Windows a .cmd or script starts without a shell, inside a job that owns the agent's whole tree.
  const prepared = prepareSpawn(options.command, options.args, { cwd, env });
  // Reported like Node's own spawn failure, so callers see one error for a missing command on every platform.
  if (!prepared.ok) throw Object.assign(new Error(`spawn ${options.command} ENOENT: ${prepared.message}`), { code: "ENOENT", syscall: "spawn" });
  const posix = process.platform !== "win32";
  const child = spawn(prepared.file, prepared.args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: posix,
    ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  const spawnFailure = new Promise<never>((_resolve, reject) => child.once("error", reject));
  spawnFailure.catch(() => {});
  const limit = options.stderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let stderr = Buffer.alloc(0);
  let dropped = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > limit) { stderr = stderr.subarray(stderr.length - limit); dropped = true; }
  });
  // One line is one message: with a limit, a line over it is never buffered whole, it ends the peer.
  const maxFrame = options.maxFrameBytes ?? Infinity;
  let lineBytes = 0;
  let rejectFrame!: (error: Error) => void;
  const frameFailure = new Promise<never>((_resolve, reject) => { rejectFrame = reject; });
  frameFailure.catch(() => {});
  const guard = new Transform({ transform(chunk: Buffer, _encoding, done) {
    for (let start = 0; ;) {
      const newline = chunk.indexOf(10, start);
      const length = (newline < 0 ? chunk.length : newline) - start;
      if (lineBytes + length > maxFrame) {
        rejectFrame(Object.assign(new Error(`message longer than ${maxFrame} bytes`), { code: "frame_too_large" }));
        signal("SIGKILL");
        done();
        return;
      }
      if (newline < 0) { lineBytes += length; break; }
      lineBytes = 0;
      start = newline + 1;
    }
    done(null, chunk);
  } });
  child.stdout.pipe(guard);
  consume(guard, child);
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const signal = (name: NodeJS.Signals) => {
    if (!posix) { terminateTree(child, { jobbed: prepared.jobbed }); return; }
    // The group outlives a leader that already exited, so it is signalled whenever the child was started.
    // macOS answers EPERM for a group whose members have all exited but are not yet reaped: nothing is left to signal.
    try { if (child.pid) process.kill(-child.pid, name); }
    catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  };
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (exited()) { resolve(true); return; }
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(exited()); }, timeoutMs);
    child.once("exit", onExit);
  });
  const groupAlive = () => {
    if (!posix || !child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch { return false; }
  };
  // What the child started outlives it in its group: once the child is gone (stopped, or crashed between turns),
  // the rest of the group gets SIGTERM and, after a second, SIGKILL.
  let cleared: Promise<void> | undefined;
  const clearGroup = () => cleared ??= (async () => {
    if (!groupAlive()) return;
    signal("SIGTERM");
    for (let waited = 0; waited < GROUP_GRACE_MS && groupAlive(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!groupAlive()) return;
    signal("SIGKILL");
    // SIGKILL is delivered asynchronously; the group is cleared once it is gone, so a caller can rely on that.
    for (let waited = 0; waited < GROUP_GRACE_MS && groupAlive(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  })();
  child.once("exit", () => { void clearGroup(); });
  const peer: LinePeer = {
    child, jobbed: prepared.jobbed, spawnFailure, frameFailure, exited, signal, waitForExit,
    stderrTail: () => `${dropped ? "[stderr truncated]\n" : ""}${stderr.toString("utf8")}`,
    async stop(graceMs) {
      if (!child.stdin.destroyed) child.stdin.end();
      if (!(graceMs > 0 && await waitForExit(graceMs))) {
        signal("SIGTERM");
        if (!(await waitForExit(1000))) {
          signal("SIGKILL");
          if (!(await waitForExit(1000))) throw new Error(`process ${child.pid} did not exit after SIGKILL`);
        }
      }
      await clearGroup();
    },
  };
  return peer;
}
