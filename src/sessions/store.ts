import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSessionRetentionDays } from "../config.js";
import { initializeSessionSchema } from "./schema.js";

export interface SessionStoreOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  now?: () => number;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profileName?: string;
  configPath?: string;
  modelId?: string;
}

export interface CreateSessionOptions {
  cwd: string;
  title: string;
  profileName?: string;
  configPath?: string;
  modelId?: string;
  provider?: string;
  method?: string;
  endpoint?: string;
  systemPrompt?: string;
  cacheKey?: string;
}

export interface HistoryItem {
  sessionId: string;
  sequence: number;
  createdAt: number;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
}

export interface Page<T> { items: T[]; nextCursor?: string }

interface ListOptions { cwd?: string; before?: string; limit?: number }
interface HistoryOptions { sessionId: string; before?: string; limit?: number }
interface AppendHistoryOptions { sessionId: string; kind: string; payload: Record<string, unknown>; status?: string }

type DbRow = Record<string, unknown>;

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("page limit must be an integer from 1 to 100");
  return value;
}

function cursorData(value: string, kind: "sessions" | "history", scope: string): { timestamp?: number; id?: string; sequence?: number } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("encoding");
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Buffer.from(JSON.stringify(decoded)).toString("base64url") !== value) throw new Error("encoding");
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("shape");
    const record = decoded as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== kind || record.scope !== scope) throw new Error("scope");
    if (kind === "sessions" && Number.isSafeInteger(record.timestamp) && typeof record.id === "string" && record.id) {
      return { timestamp: record.timestamp as number, id: record.id };
    }
    if (kind === "history" && Number.isSafeInteger(record.sequence) && (record.sequence as number) > 0) {
      return { sequence: record.sequence as number };
    }
  } catch { /* malformed and foreign cursors share one public error */ }
  throw new Error("invalid or foreign session cursor");
}

function makeCursor(kind: "sessions" | "history", scope: string, position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, scope, ...position })).toString("base64url");
}

function pathForState(options: SessionStoreOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const base = env.XDG_STATE_HOME ? resolve(cwd, env.XDG_STATE_HOME) : join(options.home ?? homedir(), ".local", "state");
  return join(base, "raw", "sessions.sqlite");
}

function sessionRow(row: DbRow): SessionSummary {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), cwd: String(row.display_path), title: String(row.title),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.profile_name === null ? {} : { profileName: String(row.profile_name) }),
    ...(row.config_path === null ? {} : { configPath: String(row.config_path) }),
    ...(row.model_id === null ? {} : { modelId: String(row.model_id) }),
  };
}

export class SessionStore {
  readonly database: DatabaseSync;
  readonly path: string;
  readonly storeId: string;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | undefined;
  private readonly cwd: string | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home;
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.path = pathForState(options);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.database = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      initializeSessionSchema(this.database);
      this.storeId = String(this.database.prepare("SELECT value FROM store_meta WHERE key = 'id'").get()?.value);
      if (!this.storeId || this.storeId === "undefined") throw new Error("session store identity is missing");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void { this.database.close(); }

  private cutoff(): number {
    return this.now() - readSessionRetentionDays({ env: this.env,
      ...(this.home ? { home: this.home } : {}), ...(this.cwd ? { cwd: this.cwd } : {}) }) * 86_400_000;
  }

  private transaction<T>(run: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(options: CreateSessionOptions): SessionSummary {
    const canonical = realpathSync(resolve(options.cwd));
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp)) throw new Error("invalid session clock");
    const id = randomUUID();
    return this.transaction(() => {
      const workspace = this.database.prepare("SELECT id FROM workspaces WHERE canonical_path = ?").get(canonical);
      const workspaceId = workspace ? String(workspace.id) : randomUUID();
      if (!workspace) this.database.prepare("INSERT INTO workspaces(id, canonical_path, display_path) VALUES (?, ?, ?)").run(workspaceId, canonical, resolve(options.cwd));
      this.database.prepare(`INSERT INTO sessions(id, workspace_id, title, created_at, updated_at, profile_name,
        config_path, model_id, provider, method, endpoint, system_prompt, cache_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, options.title, timestamp, timestamp,
        options.profileName ?? null, options.configPath ?? null, options.modelId ?? null, options.provider ?? null,
        options.method ?? null, options.endpoint ?? null, options.systemPrompt ?? null, options.cacheKey ?? null);
      return this.getSession(id)!;
    });
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.database.prepare(`SELECT s.*, w.display_path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ? AND s.updated_at > ?`).get(id, this.cutoff());
    return row ? sessionRow(row) : undefined;
  }

  listSessions(options: ListOptions = {}): Page<SessionSummary> {
    const limit = boundedLimit(options.limit);
    const cwd = options.cwd === undefined ? undefined : realpathSync(resolve(options.cwd));
    const scope = `${this.storeId}:${cwd ?? "*"}`;
    const before = options.before === undefined ? undefined : cursorData(options.before, "sessions", scope);
    const workspaceId = cwd === undefined ? undefined : this.database.prepare("SELECT id FROM workspaces WHERE canonical_path = ?").get(cwd)?.id;
    if (cwd !== undefined && workspaceId === undefined) return { items: [] };
    const conditions = ["s.updated_at > ?"];
    const parameters: Array<string | number> = [this.cutoff()];
    if (workspaceId !== undefined) {
      conditions.unshift("s.workspace_id = ?");
      parameters.unshift(String(workspaceId));
    }
    if (before) {
      conditions.push("(s.updated_at, s.id) < (?, ?)");
      parameters.push(before.timestamp!, before.id!);
    }
    const rows = this.database.prepare(`SELECT s.*, w.display_path FROM sessions s
      JOIN workspaces w ON w.id = s.workspace_id WHERE ${conditions.join(" AND ")}
      ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`).all(...parameters, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(sessionRow);
    const last = items.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: makeCursor("sessions", scope, { timestamp: last.updatedAt, id: last.id }) } : {}) };
  }

  appendHistory(options: AppendHistoryOptions): HistoryItem {
    return this.transaction(() => {
      if (!this.getSession(options.sessionId)) throw new Error("session not found or expired");
      const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?").get(options.sessionId)?.next);
      const createdAt = this.now();
      this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(options.sessionId, sequence, createdAt, options.kind, JSON.stringify(options.payload), options.status ?? "complete");
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(createdAt, options.sessionId);
      return { sessionId: options.sessionId, sequence, createdAt, kind: options.kind, payload: options.payload, status: options.status ?? "complete" };
    });
  }

  getSessionHistory(options: HistoryOptions): Page<HistoryItem> {
    const limit = boundedLimit(options.limit);
    const scope = `${this.storeId}:${options.sessionId}`;
    const before = options.before === undefined ? undefined : cursorData(options.before, "history", scope);
    if (!this.getSession(options.sessionId)) throw new Error("session not found or expired");
    const rows = before
      ? this.database.prepare(`SELECT session_id, sequence, created_at, kind, payload_json, status FROM history
        WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(options.sessionId, before.sequence!, limit + 1)
      : this.database.prepare(`SELECT session_id, sequence, created_at, kind, payload_json, status FROM history
        WHERE session_id = ? ORDER BY sequence DESC LIMIT ?`).all(options.sessionId, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map((row): HistoryItem => ({
      sessionId: String(row.session_id), sequence: Number(row.sequence), createdAt: Number(row.created_at),
      kind: String(row.kind), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, status: String(row.status),
    }));
    const oldest = items[0];
    return { items, ...(hasMore && oldest ? { nextCursor: makeCursor("history", scope, { sequence: oldest.sequence }) } : {}) };
  }

  deleteSession(id: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM sessions WHERE id = ? AND owner_token IS NULL").run(id);
    });
  }
}

export function openSessionStore(options: SessionStoreOptions = {}): SessionStore { return new SessionStore(options); }
export function sessionStorePath(options: SessionStoreOptions = {}): string { return pathForState(options); }
