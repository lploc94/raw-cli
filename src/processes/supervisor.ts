import { Commands, type CommandRecord } from "./presentation.js";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import type { SessionStore } from "../sessions/store.js";
import { spawnShell, signalShellGroup } from "../tools/process.js";
import { ProcessStore } from "./store.js";
import { LIVE_PROCESS_STATES, ProcessError, type ProcessChunk, type ProcessContext, type ProcessOutput, type ProcessRecord, type ProcessStart } from "./contract.js";
const CAP = 1024 * 1024;
interface Job {
  record: ProcessRecord; chunks: ProcessChunk[]; child?: ChildProcess; deadline?: NodeJS.Timeout; flushTimer?: NodeJS.Timeout;
  closed: Promise<void>; finish(): void; stopTask?: Promise<ProcessRecord>;
  persistenceError?: ProcessError;
}
/** Host-owned child handles, independent of an agent turn or its completed AbortSignal. */
export class ProcessSupervisor {
  readonly commands: Commands;
  private readonly token = `${process.pid}-${randomUUID()}`;
  private readonly generation = 1;
  private readonly jobs = new Map<string, Job>();
  private readonly storage?: ProcessStore;
  private readonly fences = new Set<string>();
  private closing = false;
  private failureCleanup?: Promise<void>;
  constructor(private readonly options: { store?: SessionStore; platform?: NodeJS.Platform; now?: () => number; publish?: (record: ProcessRecord) => void; publishCommands?: (sessionId: string, items: CommandRecord[]) => void; signalGroup?: typeof signalShellGroup } = {}) {
    if (options.store) this.storage = new ProcessStore(options.store, this.token, this.generation, options.now);
    this.commands = new Commands({ ...(options.store ? {store: options.store} : {}), hostToken:this.token,
      list: sid => this.list(sid), output:(sid,id,cursor,max)=>this.output(sid,id,cursor,max),
      ...(options.publishCommands ? {publish:options.publishCommands} : {}) });
  }
  get hostToken(): string { return this.token; }
  private now() { return (this.options.now ?? Date.now)(); }
  assertStoreBinding(store: SessionStore): void {
    if (!this.options.store || this.options.store.storeId !== store.storeId || realpathSync(this.options.store.path) !== realpathSync(store.path))
      throw new ProcessError("process_store_mismatch", "persisted agents require a supervisor bound to the same session store");
  }
  forSession(sessionId: string): ProcessContext {
    return { start: input => this.start(sessionId, input), list: () => this.list(sessionId), status: id => this.read(sessionId, id).record,
      output: (id, cursor, maxBytes) => this.output(sessionId, id, cursor, maxBytes), stop: id => this.stop(sessionId, id) };
  }
  private list(sessionId: string): ProcessRecord[] {
    return this.storage ? this.storage.list(sessionId) : [...this.jobs.values()].filter(job => job.record.sessionId === sessionId).map(job => structuredClone(job.record));
  }
  private read(sessionId: string, id: string): { record: ProcessRecord; chunks: ProcessChunk[] } {
    const job = this.jobs.get(id);
    if (job?.record.sessionId === sessionId) return { record: structuredClone(job.record), chunks: structuredClone(job.chunks) };
    const stored = this.storage?.read(sessionId, id);
    if (stored) return stored;
    throw new ProcessError("process_not_found", "process not found in this session");
  }
  private flush(job: Job): ProcessError | undefined {
    if (job.flushTimer) clearTimeout(job.flushTimer); delete job.flushTimer;
    job.record.revision++; job.record.updatedAt = this.now();
    try { this.storage?.save(job.record, job.chunks); delete job.persistenceError; }
    catch (error) {
      const failure = new ProcessError("process_persistence_error", `process persistence failed: ${error instanceof Error ? error.message : String(error)}`);
      job.persistenceError = failure; job.record.error = failure.message; this.closing = true;
      // Finish lifecycle cleanup through owned handles even if persistence stays unavailable.
      this.failureCleanup ??= Promise.resolve().then(() => this.close()).catch(() => { /* close() reports failure; durable ownership remains retained. */ });
      return failure;
    }
    this.commands.publish(job.record.sessionId);
    try { this.options.publish?.(structuredClone(job.record)); } catch { /* Observers cannot change process ownership. */ }
  }
  private append(job: Job, channel: ProcessChunk["channel"], text: string): void {
    if (!text) return;
    const start = job.record.cursor; const end = start + Buffer.byteLength(text);
    job.record.cursor = end; job.chunks.push({ channel, start, end, text });
    while (job.chunks.length && end - job.chunks[0]!.start > CAP) {
      const first = job.chunks[0]!;
      if (first.end <= end - CAP) { job.chunks.shift(); continue; }
      const buffer = Buffer.from(first.text); let skip = end - CAP - first.start;
      while (skip < buffer.length && (buffer[skip]! & 0xc0) === 0x80) skip++;
      first.text = buffer.subarray(skip).toString("utf8"); first.start += skip;
      break;
    }
    while (job.chunks.length > 4096) job.chunks.shift();
    job.record.earliestCursor = job.chunks[0]?.start ?? end;
    job.record.droppedBytes = job.record.earliestCursor;
    if (!job.flushTimer) job.flushTimer = setTimeout(() => this.flush(job), 250);
  }
  private async start(sessionId: string, input: ProcessStart): Promise<ProcessRecord> {
    if ((this.options.platform ?? process.platform) === "win32") throw new ProcessError("unsupported_platform", "managed background processes support macOS/Linux");
    if (this.closing) throw new ProcessError("process_unavailable", "process supervisor is closing");
    if (this.fences.has(sessionId)) throw new ProcessError("session_deleting", "session deletion is in progress");
    if (input.signal?.aborted) throw new ProcessError("aborted", "process start cancelled before spawn");
    if (typeof input.command !== "string" || !input.command.trim() || typeof input.cwd !== "string") throw new ProcessError("invalid_arguments", "command and cwd are required");
    if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 2147483647)) throw new ProcessError("invalid_arguments", "timeout_ms is out of range");
    if (!this.storage && ([...this.jobs.values()].filter(job => LIVE_PROCESS_STATES.includes(job.record.state)).length >= 32
      || this.list(sessionId).filter(record => LIVE_PROCESS_STATES.includes(record.state)).length >= 8)) throw new ProcessError("process_limit", "managed process limit reached");
    const record: ProcessRecord = { id: randomUUID(), sessionId, hostToken: this.token, hostGeneration: this.generation, revision: 1,
      command: input.command, cwd: input.cwd, ...(input.label !== undefined ? { label: input.label } : {}), state: "starting", createdAt: this.now(), updatedAt: this.now(), earliestCursor: 0, cursor: 0, droppedBytes: 0 };
    this.storage?.reserve(record);
    let finish!: () => void; const closed = new Promise<void>(resolve => { finish = resolve; });
    const job: Job = { record, chunks: [], closed, finish }; this.jobs.set(record.id, job);
    const out = new StringDecoder("utf8"); const err = new StringDecoder("utf8");
    let spawned!: () => void; let spawnFailed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { spawned = resolve; spawnFailed = reject; });
    const cancel = () => { void this.stop(sessionId, record.id).catch(() => {}); };
    try {
      const child = spawnShell(input, this.options.platform); job.child = child;
      child.stdout!.on("data", (chunk: Buffer) => this.append(job, "stdout", out.write(chunk)));
      child.stderr!.on("data", (chunk: Buffer) => this.append(job, "stderr", err.write(chunk)));
      child.once("spawn", spawned);
      child.once("error", error => { record.error = error.message; spawnFailed(error); });
      child.once("exit", (code, signal) => {
        record.exitCode = code; record.signal = signal;
        if (record.state !== "stopping") {
          // A completed leader must not leave ignored-stdio descendants outside lifecycle cleanup.
          try { (this.options.signalGroup ?? signalShellGroup)(child, "SIGKILL", this.options.platform); }
          catch (error) { record.state = "stopping"; record.error = `process group cleanup failed: ${String(error)}`; this.flush(job); }
        }
      });
      child.once("close", () => {
        this.append(job, "stdout", out.end()); this.append(job, "stderr", err.end());
        if (job.deadline) clearTimeout(job.deadline);
        if (record.state !== "stopping") {
          record.state = record.error || record.exitCode !== 0 ? "failed" : "exited";
          record.endedAt = this.now(); this.flush(job);
        }
        finish(); this.trim(sessionId);
      });
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
      await ready;
      if (input.signal?.aborted || this.closing) { await this.stop(sessionId, record.id); throw new ProcessError("aborted", "process start cancelled before acknowledgement"); }
      if (record.state === "starting") {
        record.state = "running"; const failure = this.flush(job);
        if (failure) { await this.stop(sessionId, record.id).catch(() => {}); throw failure; }
      }
      if (input.timeout_ms !== undefined && LIVE_PROCESS_STATES.includes(record.state)) job.deadline = setTimeout(() => { void this.stop(sessionId, record.id, "timed_out").catch(() => {}); }, input.timeout_ms);
      return structuredClone(record);
    } catch (error) {
      if (record.state === "starting") { record.state = "failed"; record.error = error instanceof Error ? error.message : String(error); record.endedAt = this.now(); this.flush(job); }
      this.trim(sessionId);
      throw error instanceof ProcessError ? error : new ProcessError("process_spawn_error", `cannot start process: ${record.error ?? String(error)}`);
    } finally { input.signal?.removeEventListener("abort", cancel); }
  }
  private trim(sessionId: string) {
    const terminal = [...this.jobs.values()].filter(job => job.record.sessionId === sessionId && !LIVE_PROCESS_STATES.includes(job.record.state)).sort((a,b) => b.record.createdAt - a.record.createdAt || b.record.id.localeCompare(a.record.id));
    for (const job of terminal.slice(100)) this.jobs.delete(job.record.id);
  }
  private async stop(sessionId: string, id: string, outcome: "stopped" | "timed_out" = "stopped"): Promise<ProcessRecord> {
    const record = this.read(sessionId, id).record;
    if (!LIVE_PROCESS_STATES.includes(record.state)) return record;
    const job = this.jobs.get(id);
    if (!job?.child || job.record.hostToken !== this.token) throw new ProcessError("process_foreign_host", "the owning process host is unavailable here");
    if (job.stopTask) return job.stopTask;
    const task = (async () => {
      job.record.state = "stopping"; this.flush(job);
      if (job.deadline) clearTimeout(job.deadline);
      (this.options.signalGroup ?? signalShellGroup)(job.child!, "SIGTERM", this.options.platform);
      await new Promise(resolve => setTimeout(resolve, 500));
      (this.options.signalGroup ?? signalShellGroup)(job.child!, "SIGKILL", this.options.platform);
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([job.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProcessError("process_cleanup_failed", "cannot confirm process group cleanup")), 1500); })]); }
      finally { if (timer) clearTimeout(timer); }
      job.record.state = outcome; job.record.endedAt = this.now(); const failure = this.flush(job); this.trim(sessionId);
      if (failure) throw failure;
      return structuredClone(job.record);
    })();
    job.stopTask = task;
    try { return await task; } catch (error) { delete job.stopTask; throw error; }
  }
  private output(sessionId: string, id: string, cursor = 0, maxBytes = 65536): ProcessOutput {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new ProcessError("invalid_arguments", "invalid output cursor or page size");
    const { record, chunks } = this.read(sessionId, id); let nextCursor = Math.min(record.cursor, Math.max(cursor, record.earliestCursor)); let remaining = maxBytes;
    const selected: ProcessChunk[] = [];
    for (const chunk of chunks) {
      if (chunk.end <= nextCursor || !remaining) continue;
      const buffer = Buffer.from(chunk.text); let offset = Math.max(0, nextCursor - chunk.start);
      while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset++;
      nextCursor = chunk.start + offset;
      let end = Math.min(buffer.length, offset + remaining);
      while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
      if (end === offset) {
        if (offset < buffer.length && !selected.length) throw new ProcessError("output_budget_too_small", "output page cannot hold the next UTF-8 character");
        break;
      }
      const text = buffer.subarray(offset, end).toString("utf8"); selected.push({ channel: chunk.channel, start: chunk.start + offset, end: chunk.start + end, text });
      remaining -= end - offset; nextCursor = chunk.start + end;
      if (end < buffer.length) break;
    }
    return { id, chunks: selected, earliestCursor: record.earliestCursor, nextCursor, cursor: record.cursor, droppedBytes: record.droppedBytes, truncated: cursor < record.earliestCursor || nextCursor < record.cursor };
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.options.store || !this.storage) throw new ProcessError("process_unavailable", "session deletion requires a persistent supervisor bound to its store");
    if (!this.options.store.getSession(sessionId)) throw new ProcessError("session_not_found", this.options.store.missingSessionMessage());
    this.storage.fence(sessionId); this.fences.add(sessionId);
    try {
      for (const record of this.list(sessionId)) if (LIVE_PROCESS_STATES.includes(record.state)) await this.stop(sessionId, record.id);
      this.options.store.deleteSession(sessionId, { token: this.token, generation: this.generation });
      this.commands.forgetSession(sessionId);
      for (const [id, job] of this.jobs) if (job.record.sessionId === sessionId) this.jobs.delete(id);
    } finally { this.storage?.unfence(sessionId); this.fences.delete(sessionId); }
  }
  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.jobs.values()].map(async job => {
      if (LIVE_PROCESS_STATES.includes(job.record.state)) await this.stop(job.record.sessionId, job.record.id);
      else if (job.persistenceError) { const failure = this.flush(job); if (failure) throw failure; }
    }));
    if (results.some(result => result.status === "rejected")) throw new ProcessError("process_cleanup_failed", "managed process cleanup did not finish; records retained");
    this.commands.close();
    this.storage?.close();
  }
}
