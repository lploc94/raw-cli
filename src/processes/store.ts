import type { DatabaseSync } from "node:sqlite";
import type { SessionStore } from "../sessions/store.js";
import { LIVE_PROCESS_STATES, ProcessError, type ProcessChunk, type ProcessRecord } from "./contract.js";
const live = "('starting','running','stopping')";
function pruneTerminalProcesses(database: DatabaseSync, sessionId: string): void {
  database.prepare(`DELETE FROM session_processes WHERE session_id = ? AND state NOT IN ${live} AND id NOT IN
    (SELECT id FROM session_processes WHERE session_id = ? AND state NOT IN ${live} ORDER BY created_at DESC, id DESC LIMIT 100)`).run(sessionId, sessionId);
}
export function hostPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Runs inside the caller's deletion transaction. Never signals stored process IDs. */
export function recoverProcessHosts(database: DatabaseSync, now: number, alive = hostPidAlive): void {
  const affectedSessions = new Set<string>();
  for (const host of database.prepare("SELECT token, generation, pid, alive FROM process_hosts").all()) {
    if (Number(host.alive) && alive(Number(host.pid))) continue;
    database.prepare("DELETE FROM session_process_fences WHERE host_token = ? AND host_generation = ?").run(String(host.token), Number(host.generation));
    database.prepare("UPDATE process_hosts SET alive = 0, updated_at = ? WHERE token = ? AND generation = ?").run(now, String(host.token), Number(host.generation));
    for (const row of database.prepare(`SELECT id, record_json FROM session_processes WHERE host_token = ? AND host_generation = ? AND state IN ${live}`).all(String(host.token), Number(host.generation))) {
      const record = JSON.parse(String(row.record_json)) as ProcessRecord;
      affectedSessions.add(record.sessionId);
      Object.assign(record, { state: "lost", revision: record.revision + 1, endedAt: now, updatedAt: now, error: "owning host is no longer alive" });
      database.prepare("UPDATE session_processes SET state = 'lost', revision = ?, record_json = ? WHERE id = ?").run(record.revision, JSON.stringify(record), String(row.id));
    }
  }
  for (const sessionId of affectedSessions) pruneTerminalProcesses(database, sessionId);
  database.prepare(`DELETE FROM process_hosts WHERE alive = 0
    AND NOT EXISTS (SELECT 1 FROM session_processes WHERE host_token = process_hosts.token)
    AND NOT EXISTS (SELECT 1 FROM session_process_fences WHERE host_token = process_hosts.token)`).run();
}
export function assertNoLiveProcesses(database: DatabaseSync, sessionId: string, now: number): void {
  recoverProcessHosts(database, now);
  if (database.prepare(`SELECT 1 FROM session_processes WHERE session_id = ? AND state IN ${live} LIMIT 1`).get(sessionId))
    throw new ProcessError("session_process_busy", "session is busy with managed processes owned by a live host");
}
export class ProcessStore {
  constructor(readonly store: SessionStore, readonly token: string, readonly generation: number, private readonly now = Date.now) {
    const db = store.database;
    recoverProcessHosts(db, now());
    db.prepare("INSERT INTO process_hosts(token, generation, pid, alive, updated_at) VALUES (?, ?, ?, 1, ?)").run(token, generation, process.pid, now());
  }
  private transaction<T>(fn: () => T): T {
    const db = this.store.database; db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  reserve(record: ProcessRecord): void {
    this.transaction(() => {
      const db = this.store.database;
      if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(record.sessionId)) throw new ProcessError("session_not_found", "session not found");
      if (!db.prepare("SELECT 1 FROM process_hosts WHERE token = ? AND generation = ? AND alive = 1").get(this.token, this.generation)) throw new ProcessError("process_owner_lost", "process host ownership lost");
      if (db.prepare("SELECT 1 FROM session_process_fences WHERE session_id = ?").get(record.sessionId)) throw new ProcessError("session_deleting", "session deletion is in progress");
      recoverProcessHosts(db, this.now());
      if (Number(db.prepare(`SELECT COUNT(*) AS n FROM session_processes WHERE session_id = ? AND state IN ${live}`).get(record.sessionId)!.n) >= 8
        || Number(db.prepare(`SELECT COUNT(*) AS n FROM session_processes WHERE host_token = ? AND host_generation = ? AND state IN ${live}`).get(this.token, this.generation)!.n) >= 32)
        throw new ProcessError("process_limit", "managed process limit reached");
      db.prepare("INSERT INTO session_processes(id, session_id, host_token, host_generation, state, revision, created_at, record_json, chunks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')")
        .run(record.id, record.sessionId, this.token, this.generation, record.state, record.revision, record.createdAt, JSON.stringify(record));
    });
  }
  save(record: ProcessRecord, chunks: ProcessChunk[]): void {
    this.transaction(() => {
      const db = this.store.database;
      const host = db.prepare("SELECT alive FROM process_hosts WHERE token = ? AND generation = ?").get(this.token, this.generation);
      if (!host || !Number(host.alive)) throw new ProcessError("process_owner_lost", "process host ownership lost");
      const changed = db.prepare("UPDATE session_processes SET state = ?, revision = ?, record_json = ?, chunks_json = ? WHERE id = ? AND host_token = ? AND host_generation = ? AND revision < ?")
        .run(record.state, record.revision, JSON.stringify(record), JSON.stringify(chunks), record.id, this.token, this.generation, record.revision);
      if (changed.changes !== 1) throw new ProcessError("process_conflict", "process record changed or ownership lost");
      if (!LIVE_PROCESS_STATES.includes(record.state)) pruneTerminalProcesses(db, record.sessionId);
    });
  }
  list(sessionId: string): ProcessRecord[] {
    recoverProcessHosts(this.store.database, this.now());
    return this.store.database.prepare("SELECT record_json FROM session_processes WHERE session_id = ? ORDER BY created_at, id").all(sessionId).map(row => JSON.parse(String(row.record_json)) as ProcessRecord);
  }
  read(sessionId: string, id: string): { record: ProcessRecord; chunks: ProcessChunk[] } | undefined {
    recoverProcessHosts(this.store.database, this.now());
    const row = this.store.database.prepare("SELECT record_json, chunks_json FROM session_processes WHERE session_id = ? AND id = ?").get(sessionId, id);
    return row ? { record: JSON.parse(String(row.record_json)) as ProcessRecord, chunks: JSON.parse(String(row.chunks_json)) as ProcessChunk[] } : undefined;
  }
  fence(sessionId: string): void {
    this.transaction(() => {
      const db = this.store.database;
      recoverProcessHosts(db, this.now());
      if (db.prepare(`SELECT 1 FROM session_processes WHERE session_id = ? AND state IN ${live} AND (host_token != ? OR host_generation != ?) LIMIT 1`).get(sessionId, this.token, this.generation))
        throw new ProcessError("session_process_busy", "session is busy with another process host");
      const fence = db.prepare("SELECT host_token, host_generation FROM session_process_fences WHERE session_id = ?").get(sessionId);
      if (fence && (fence.host_token !== this.token || Number(fence.host_generation) !== this.generation)) throw new ProcessError("session_deleting", "session deletion is in progress");
      if (!fence) db.prepare("INSERT INTO session_process_fences(session_id, host_token, host_generation) VALUES (?, ?, ?)").run(sessionId, this.token, this.generation);
    });
  }
  unfence(sessionId: string): void { this.store.database.prepare("DELETE FROM session_process_fences WHERE session_id = ? AND host_token = ? AND host_generation = ?").run(sessionId, this.token, this.generation); }
  close(): void {
    this.store.database.prepare("UPDATE process_hosts SET alive = 0, updated_at = ? WHERE token = ? AND generation = ?").run(this.now(), this.token, this.generation);
    recoverProcessHosts(this.store.database, this.now());
  }
}
