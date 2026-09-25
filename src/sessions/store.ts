import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSessionRetentionDays } from "../config.js";
import type { UsageRecord } from "../llm/cache.js";
import type { ModelMessage, ProviderProfile, UserInput } from "../llm/types.js";
import type { ToolDefinition } from "../tools/registry.js";
import { errorResult } from "../tools/results.js";
import { initializeSessionSchema } from "./schema.js";
import { isEphemeralPeerAlias } from "./restore.js";

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
export interface SessionStorageStats {
  workspaces: number;
  sessions: number;
  historyItems: number;
  modelMessages: number;
  payloadFiles: number;
  databaseBytes: number;
  walBytes: number;
  payloadBytes: number;
}

export interface SessionOwner { token: string; generation: number }
export interface AgentIdentity {
  cwd: string;
  system: string;
  profile: Readonly<ProviderProfile>;
  toolDefinitions: readonly ToolDefinition[];
  selectedTools: readonly string[] | null;
  cacheKey: string;
  allowPeerToolDrop?: boolean;
}
export interface StoredAgentState {
  messages: ModelMessage[];
  originalTask?: UserInput;
  summaryText?: string;
  cacheKey: string;
  selectedTools: readonly string[] | null;
  schemaRevision: number;
  tokenCalibration: number;
  rawUsage: unknown[];
  usageEntries: UsageRecord[];
}
export interface AgentMetadata {
  originalTask?: UserInput;
  summaryText?: string;
  rawUsage?: readonly unknown[];
  usageEntries?: readonly UsageRecord[];
  tokenCalibration?: number;
  schemaRevision?: number;
}
export interface VisibleRecord { kind: string; payload: Record<string, unknown>; status?: string }

interface ListOptions { cwd?: string; before?: string; limit?: number }
interface HistoryOptions { sessionId: string; before?: string; limit?: number }
interface AppendHistoryOptions { sessionId: string; kind: string; payload: Record<string, unknown>; status?: string }

type DbRow = Record<string, unknown>;
interface StagedPayload { id: string; relativePath: string; byteLength: number }
interface StagedValue { encoded: string; payloads: StagedPayload[] }

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

function nonPeerSchemaDigest(definitions: readonly ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(definitions.filter((item) => !isEphemeralPeerAlias(item.name)))).digest("hex");
}

function nonPeerSchemaKey(sessionId: string): string { return `non_peer_schema:${sessionId}`; }

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

  private ownerRow(sessionId: string, owner: SessionOwner): DbRow {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ? AND owner_token = ? AND owner_generation = ?")
      .get(sessionId, owner.token, owner.generation);
    if (!row) throw new Error("session ownership lost");
    return row;
  }

  private ownerAlive(token: string): boolean {
    const pid = Number(token.split("-")[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }

  claimSession(sessionId: string): SessionOwner {
    return this.transaction(() => {
      const row = this.database.prepare("SELECT owner_token, owner_generation, lease_until, updated_at FROM sessions WHERE id = ?").get(sessionId);
      if (!row || Number(row.updated_at) <= this.cutoff()) throw new Error("session not found or expired");
      if (row.owner_token !== null && (Number(row.lease_until) > this.now() || this.ownerAlive(String(row.owner_token)))) {
        throw new Error("session is busy in another process");
      }
      const owner = { token: `${process.pid}-${randomUUID()}`, generation: Number(row.owner_generation) + 1 };
      this.database.prepare("UPDATE sessions SET owner_token = ?, owner_generation = ?, lease_until = ? WHERE id = ?")
        .run(owner.token, owner.generation, this.now() + 15_000, sessionId);
      return owner;
    });
  }

  renewSession(sessionId: string, owner: SessionOwner): void {
    const result = this.database.prepare("UPDATE sessions SET lease_until = ? WHERE id = ? AND owner_token = ? AND owner_generation = ?")
      .run(this.now() + 15_000, sessionId, owner.token, owner.generation);
    if (result.changes !== 1) throw new Error("session ownership lost");
  }

  releaseSession(sessionId: string, owner: SessionOwner): void {
    this.database.prepare("UPDATE sessions SET owner_token = NULL, lease_until = NULL WHERE id = ? AND owner_token = ? AND owner_generation = ?")
      .run(sessionId, owner.token, owner.generation);
  }

  setTitleFromPrompt(sessionId: string, owner: SessionOwner, prompt: string): void {
    const title = prompt.trim().replace(/\s+/g, " ").slice(0, 80) || "New session";
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      this.database.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = 'New session'").run(title, sessionId);
    });
  }

  storageStats(): SessionStorageStats {
    const count = (table: string): number => Number(this.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    const bytes = (path: string): number => {
      try { return statSync(path).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    };
    return {
      workspaces: count("workspaces"), sessions: count("sessions"), historyItems: count("history"),
      modelMessages: count("model_context"), payloadFiles: count("payloads"),
      databaseBytes: bytes(this.path), walBytes: bytes(`${this.path}-wal`),
      payloadBytes: Number(this.database.prepare("SELECT coalesce(sum(byte_length), 0) AS n FROM payloads").get()?.n),
    };
  }

  getStoredSelection(sessionId: string): readonly string[] | null | undefined {
    const value = this.database.prepare("SELECT selected_tools_json FROM sessions WHERE id = ?").get(sessionId)?.selected_tools_json;
    return value === null || value === undefined ? undefined : JSON.parse(String(value)) as readonly string[] | null;
  }

  initializeAgent(sessionId: string, owner: SessionOwner, identity: AgentIdentity): StoredAgentState {
    const canonical = realpathSync(resolve(identity.cwd));
    const digest = createHash("sha256").update(JSON.stringify(identity.toolDefinitions)).digest("hex");
    const endpointHash = createHash("sha256").update(identity.profile.baseUrl ?? "").digest("hex");
    const runtimeDigest = createHash("sha256").update(JSON.stringify({ request: identity.profile.request ?? null,
      cache: identity.profile.cache ?? null, vision: identity.profile.vision ?? false,
      contextWindow: identity.profile.contextWindow ?? null, maxOutputTokens: identity.profile.maxOutputTokens ?? null })).digest("hex");
    this.transaction(() => {
      const row = this.ownerRow(sessionId, owner);
      const workspace = this.database.prepare("SELECT canonical_path FROM workspaces WHERE id = ?").get(String(row.workspace_id));
      if (workspace?.canonical_path !== canonical) throw new Error("session cwd changed");
      if (row.tool_schema_digest === null) {
        for (const [field, expected] of [["profile_name", identity.profile.name], ["model_id", identity.profile.model],
          ["provider", identity.profile.provider], ["method", identity.profile.method], ["endpoint", endpointHash],
          ["system_prompt", identity.system]] as const) {
          if (row[field] !== null && row[field] !== expected) throw new Error(`session ${field} differs from saved identity`);
        }
        this.database.prepare(`UPDATE sessions SET profile_name = ?, model_id = ?, provider = ?, method = ?, endpoint = ?,
          system_prompt = ?, cache_key = ?, selected_tools_json = ?, tool_schema_digest = ?, runtime_digest = ? WHERE id = ?`)
          .run(identity.profile.name, identity.profile.model, identity.profile.provider, identity.profile.method,
            endpointHash, identity.system, row.cache_key === null ? identity.cacheKey : String(row.cache_key),
            JSON.stringify(identity.selectedTools), digest, runtimeDigest, sessionId);
        this.database.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
          .run(nonPeerSchemaKey(sessionId), nonPeerSchemaDigest(identity.toolDefinitions));
      } else {
        if (row.profile_name !== identity.profile.name || row.model_id !== identity.profile.model
          || row.provider !== identity.profile.provider || row.method !== identity.profile.method
          || row.endpoint !== endpointHash || row.system_prompt !== identity.system || row.runtime_digest !== runtimeDigest) {
          throw new Error("session runtime or tool schema changed; resume requires the saved profile and tool selection");
        }
        const oldSelection = JSON.parse(String(row.selected_tools_json)) as readonly string[] | null;
        const newSelection = identity.selectedTools;
        const droppedPeerTools = identity.allowPeerToolDrop && Array.isArray(oldSelection) && Array.isArray(newSelection)
          && oldSelection.length > newSelection.length
          && JSON.stringify(oldSelection.filter((name) => newSelection.includes(name))) === JSON.stringify(newSelection)
          && oldSelection.filter((name) => !newSelection.includes(name)).every(isEphemeralPeerAlias);
        if (droppedPeerTools) {
          const savedDigest = this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(nonPeerSchemaKey(sessionId))?.value;
          if (savedDigest !== nonPeerSchemaDigest(identity.toolDefinitions)) {
            throw new Error("session retained tool schema changed");
          }
          this.database.prepare(`UPDATE sessions SET selected_tools_json = ?, tool_schema_digest = ?, schema_revision = schema_revision + 1,
            cache_key = ? WHERE id = ?`).run(JSON.stringify(newSelection), digest, randomUUID(), sessionId);
        } else if (row.tool_schema_digest !== digest || row.selected_tools_json !== JSON.stringify(newSelection)) {
          throw new Error("session runtime or tool schema changed; resume requires the saved profile and tool selection");
        }
      }
    });
    this.recoverInterruptedCalls(sessionId, owner);
    return this.readAgentState(sessionId, owner);
  }

  readAgentState(sessionId: string, owner: SessionOwner): StoredAgentState {
    const row = this.ownerRow(sessionId, owner);
    const messages = this.database.prepare("SELECT payload_json FROM model_context WHERE session_id = ? ORDER BY position")
      .all(sessionId).map((item) => this.decodeStored(String(item.payload_json)) as ModelMessage);
    const usage = row.usage_json === null ? {} : JSON.parse(String(row.usage_json)) as { rawUsage?: unknown[]; usageEntries?: UsageRecord[] };
    return {
      messages, cacheKey: String(row.cache_key), selectedTools: JSON.parse(String(row.selected_tools_json)) as readonly string[] | null,
      schemaRevision: Number(row.schema_revision), tokenCalibration: Number(row.token_calibration),
      rawUsage: usage.rawUsage ?? [], usageEntries: usage.usageEntries ?? [],
      ...(row.original_task === null ? {} : { originalTask: JSON.parse(String(row.original_task)) as UserInput }),
      ...(row.summary_text === null ? {} : { summaryText: String(row.summary_text) }),
    };
  }

  private writeMetadata(sessionId: string, metadata: AgentMetadata): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (metadata.originalTask !== undefined) { fields.push("original_task = ?"); values.push(JSON.stringify(metadata.originalTask)); }
    if (metadata.summaryText !== undefined) { fields.push("summary_text = ?"); values.push(metadata.summaryText); }
    if (metadata.rawUsage !== undefined || metadata.usageEntries !== undefined) {
      const current = this.database.prepare("SELECT usage_json FROM sessions WHERE id = ?").get(sessionId)?.usage_json;
      const usage = current === null || current === undefined ? {} : JSON.parse(String(current)) as Record<string, unknown>;
      if (metadata.rawUsage !== undefined) usage.rawUsage = metadata.rawUsage;
      if (metadata.usageEntries !== undefined) usage.usageEntries = metadata.usageEntries;
      fields.push("usage_json = ?"); values.push(JSON.stringify(usage));
    }
    if (metadata.tokenCalibration !== undefined) { fields.push("token_calibration = ?"); values.push(metadata.tokenCalibration); }
    if (metadata.schemaRevision !== undefined) { fields.push("schema_revision = ?"); values.push(metadata.schemaRevision); }
    if (fields.length) this.database.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values, sessionId);
  }

  updateAgentMetadata(sessionId: string, owner: SessionOwner, metadata: AgentMetadata): void {
    this.transaction(() => { this.ownerRow(sessionId, owner); this.writeMetadata(sessionId, metadata); this.renewSession(sessionId, owner); });
  }

  updateAgentToolView(sessionId: string, owner: SessionOwner, selection: readonly string[] | null,
    definitions: readonly ToolDefinition[], revision: number): void {
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const digest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
      this.database.prepare("UPDATE sessions SET selected_tools_json = ?, tool_schema_digest = ?, schema_revision = ? WHERE id = ?")
        .run(JSON.stringify(selection), digest, revision, sessionId);
      this.database.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(nonPeerSchemaKey(sessionId), nonPeerSchemaDigest(definitions));
      this.renewSession(sessionId, owner);
    });
  }

  private stageBlob(json: string, owner: SessionOwner): StagedPayload {
    const byteLength = Buffer.byteLength(json, "utf8");
    const id = createHash("sha256").update(json).digest("hex");
    const relativePath = join("payloads", owner.token, `${id}-${randomUUID()}.json`);
    const directory = dirname(join(dirname(this.path), relativePath));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const absolutePath = join(dirname(this.path), relativePath);
    writeFileSync(absolutePath, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const file = openSync(absolutePath, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    const dir = openSync(directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return { id, relativePath, byteLength };
  }

  private stageStored(value: unknown, owner: SessionOwner): StagedValue {
    const canonical = JSON.stringify(value);
    if (canonical === undefined) throw new Error("session payload is not serializable");
    if (Buffer.byteLength(canonical, "utf8") <= 64 * 1024) return { encoded: canonical, payloads: [] };
    const refs: Array<{ path: Array<string | number>; id: string }> = [];
    const payloads: StagedPayload[] = [];
    const walk = (node: unknown, path: Array<string | number>): unknown => {
      if (typeof node === "string" && Buffer.byteLength(JSON.stringify(node), "utf8") > 64 * 1024) {
        const payload = this.stageBlob(JSON.stringify(node), owner);
        payloads.push(payload);
        refs.push({ path, id: payload.id });
        return null;
      }
      if (Array.isArray(node)) return node.map((item, index) => walk(item, [...path, index]));
      if (node && typeof node === "object") {
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(node)) result[key] = walk(item, [...path, key]);
        return result;
      }
      return node;
    };
    const compact = walk(JSON.parse(canonical) as unknown, []);
    const encoded = refs.length ? `@refs:${JSON.stringify({ value: compact, refs })}` : canonical;
    if (Buffer.byteLength(encoded, "utf8") <= 64 * 1024) return { encoded, payloads };
    const outer = this.stageBlob(encoded, owner);
    return { encoded: `@payload:${outer.id}`, payloads: [...payloads, outer] };
  }

  private addPayloadReference(staged: StagedValue): void {
    for (const { id, relativePath, byteLength } of staged.payloads) {
      this.database.prepare("INSERT OR IGNORE INTO payloads(id, relative_path, byte_length, ref_count) VALUES (?, ?, ?, 0)")
        .run(id, relativePath, byteLength);
      this.database.prepare("UPDATE payloads SET ref_count = ref_count + 1 WHERE id = ?").run(id);
    }
  }

  private dropPayloadReference(encoded: string): void {
    for (const id of this.payloadIds(encoded)) {
      this.database.prepare("UPDATE payloads SET ref_count = ref_count - 1 WHERE id = ?").run(id);
    }
  }

  private readPayload(id: string): string {
    const row = this.database.prepare("SELECT relative_path, byte_length FROM payloads WHERE id = ?").get(id);
    if (!row) throw new Error("session payload is missing");
    const bytes = readFileSync(join(dirname(this.path), String(row.relative_path)));
    if (bytes.byteLength !== Number(row.byte_length) || createHash("sha256").update(bytes).digest("hex") !== id) {
      throw new Error("session payload checksum mismatch");
    }
    return bytes.toString("utf8");
  }

  private payloadIds(encoded: string): string[] {
    if (encoded.startsWith("@payload:")) {
      const id = encoded.slice(9);
      return [id, ...this.payloadIds(this.readPayload(id))];
    }
    if (encoded.startsWith("@refs:")) {
      const envelope = JSON.parse(encoded.slice(6)) as { refs: Array<{ id: string }> };
      return envelope.refs.map((item) => item.id);
    }
    return [];
  }

  private decodeStored(encoded: string): unknown {
    if (encoded.startsWith("@payload:")) return this.decodeStored(this.readPayload(encoded.slice(9)));
    if (encoded.startsWith("@refs:")) {
      const envelope = JSON.parse(encoded.slice(6)) as {
        value: unknown; refs: Array<{ path: Array<string | number>; id: string }>;
      };
      let value = envelope.value;
      for (const ref of envelope.refs) {
        const restored = this.decodeStored(`@payload:${ref.id}`);
        if (ref.path.length === 0) { value = restored; continue; }
        let target = value as Record<string | number, unknown>;
        for (const key of ref.path.slice(0, -1)) {
          if (!Object.hasOwn(target, key)) throw new Error("invalid session payload reference path");
          target = target[key] as Record<string | number, unknown>;
        }
        Object.defineProperty(target, ref.path.at(-1)!, { value: restored, enumerable: true, writable: true, configurable: true });
      }
      return value;
    }
    return JSON.parse(encoded) as unknown;
  }

  private reclaimUnreferencedPayloads(): void {
    const stale = this.transaction(() => this.database.prepare("DELETE FROM payloads WHERE ref_count <= 0 RETURNING relative_path").all());
    for (const row of stale) {
      try { unlinkSync(join(dirname(this.path), String(row.relative_path))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private discardDuplicateStages(values: readonly StagedValue[]): void {
    for (const value of values) for (const payload of value.payloads) {
      const row = this.database.prepare("SELECT relative_path FROM payloads WHERE id = ?").get(payload.id);
      if (row?.relative_path === payload.relativePath) continue;
      try { unlinkSync(join(dirname(this.path), payload.relativePath)); }
      catch { /* A staged duplicate is an orphan; maintenance can remove it later. */ }
    }
  }

  sweepOrphans(): number {
    const payloadRoot = join(dirname(this.path), "payloads");
    if (!existsSync(payloadRoot)) return 0;
    let removed = 0;
    for (const ownerDir of readdirSync(payloadRoot, { withFileTypes: true })) {
      if (!ownerDir.isDirectory()) continue;
      const token = ownerDir.name;
      const active = this.database.prepare("SELECT 1 FROM sessions WHERE owner_token = ? LIMIT 1").get(token);
      if (active && this.ownerAlive(token)) continue;
      const directory = join(payloadRoot, token);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const relativePath = join("payloads", token, entry.name);
        if (this.database.prepare("SELECT 1 FROM payloads WHERE relative_path = ?").get(relativePath)) continue;
        unlinkSync(join(directory, entry.name));
        removed++;
      }
      if (!readdirSync(directory).length) rmdirSync(directory);
    }
    return removed;
  }

  appendAgentMessage(sessionId: string, owner: SessionOwner, message: ModelMessage, metadata: AgentMetadata = {},
    display: readonly VisibleRecord[] = []): void {
    this.ownerRow(sessionId, owner);
    const staged = this.stageStored(message, owner);
    const visible = display.map((item) => ({ item, stored: this.stageStored(item.payload, owner) }));
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const position = Number(this.database.prepare("SELECT coalesce(max(position), -1) + 1 AS next FROM model_context WHERE session_id = ?").get(sessionId)?.next);
      this.addPayloadReference(staged);
      this.database.prepare("INSERT INTO model_context(session_id, position, payload_json) VALUES (?, ?, ?)")
        .run(sessionId, position, staged.encoded);
      for (const { item, stored } of visible) {
        const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?").get(sessionId)?.next);
        this.addPayloadReference(stored);
        this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
          .run(sessionId, sequence, this.now(), item.kind, stored.encoded, item.status ?? "complete");
      }
      this.writeMetadata(sessionId, metadata);
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(this.now(), sessionId);
      this.renewSession(sessionId, owner);
    });
    this.discardDuplicateStages([staged, ...visible.map((item) => item.stored)]);
  }

  replaceAgentContext(sessionId: string, owner: SessionOwner, messages: readonly ModelMessage[], metadata: AgentMetadata = {},
    resetContextMetadata = false): void {
    this.ownerRow(sessionId, owner);
    const staged = messages.map((message) => this.stageStored(message, owner));
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const old = this.database.prepare("SELECT payload_json FROM model_context WHERE session_id = ?").all(sessionId);
      this.database.prepare("DELETE FROM model_context WHERE session_id = ?").run(sessionId);
      for (const row of old) this.dropPayloadReference(String(row.payload_json));
      for (const [position, value] of staged.entries()) {
        this.addPayloadReference(value);
        this.database.prepare("INSERT INTO model_context(session_id, position, payload_json) VALUES (?, ?, ?)").run(sessionId, position, value.encoded);
      }
      this.writeMetadata(sessionId, metadata);
      if (resetContextMetadata) this.database.prepare("UPDATE sessions SET original_task = NULL, summary_text = NULL WHERE id = ?").run(sessionId);
      this.renewSession(sessionId, owner);
    });
    this.discardDuplicateStages(staged);
    try { this.reclaimUnreferencedPayloads(); }
    catch { /* The context checkpoint committed; idle maintenance will retry reclamation. */ }
  }

  clearAgentContext(sessionId: string, owner: SessionOwner): void {
    this.replaceAgentContext(sessionId, owner, [], {}, true);
  }

  appendOwnedHistory(sessionId: string, owner: SessionOwner, kind: string, payload: Record<string, unknown>, status = "complete"): HistoryItem {
    this.ownerRow(sessionId, owner);
    const staged = this.stageStored(payload, owner);
    const item = this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?").get(sessionId)?.next);
      this.addPayloadReference(staged);
      const createdAt = this.now();
      this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, sequence, createdAt, kind, staged.encoded, status);
      this.renewSession(sessionId, owner);
      return { sessionId, sequence, createdAt, kind, payload, status };
    });
    this.discardDuplicateStages([staged]);
    return item;
  }

  recoverInterruptedCalls(sessionId: string, owner: SessionOwner): void {
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const rows = this.database.prepare("SELECT position, payload_json FROM model_context WHERE session_id = ? ORDER BY position")
        .all(sessionId);
      const messages = rows.map((row) => this.decodeStored(String(row.payload_json)) as ModelMessage);
      let assistantIndex = -1;
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === "assistant") { assistantIndex = index; break; }
        if (messages[index]?.role === "user") break;
      }
      const assistant = messages[assistantIndex];
      if (!assistant || assistant.role !== "assistant" || !assistant.toolCalls.length) return;
      const committed = new Set(messages.slice(assistantIndex + 1).filter((item) => item.role === "tool").map((item) => (item as Extract<ModelMessage, { role: "tool" }>).callId));
      const unresolved = assistant.toolCalls.filter((call) => !committed.has(call.id));
      for (const [index, call] of unresolved.entries()) {
        const code = index === 0 ? "outcome_unknown" : "cancelled";
        const result = errorResult(code, index === 0
          ? `tool ${call.name} may have run before interruption; inspect the workspace before retrying`
          : `tool ${call.name} was cancelled after interruption`);
        const position = messages.length + index;
        const message: ModelMessage = { role: "tool", callId: call.id, name: call.name, result };
        this.database.prepare("INSERT INTO model_context(session_id, position, payload_json) VALUES (?, ?, ?)")
          .run(sessionId, position, JSON.stringify(message));
        const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?").get(sessionId)?.next);
        this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
          .run(sessionId, sequence, this.now(), "tool_result", JSON.stringify({ id: call.id, name: call.name, result }), "interrupted");
      }
      if (unresolved.length) this.renewSession(sessionId, owner);
    });
  }

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
        options.method ?? null, options.endpoint === undefined ? null : createHash("sha256").update(options.endpoint).digest("hex"),
        options.systemPrompt ?? null, options.cacheKey ?? null);
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
      kind: String(row.kind), payload: this.decodeStored(String(row.payload_json)) as Record<string, unknown>, status: String(row.status),
    }));
    const oldest = items[0];
    return { items, ...(hasMore && oldest ? { nextCursor: makeCursor("history", scope, { sequence: oldest.sequence }) } : {}) };
  }

  async scanSessionHistory(sessionId: string, visit: (item: HistoryItem) => Promise<void>): Promise<void> {
    if (!this.getSession(sessionId)) throw new Error("session not found or expired");
    let after = 0;
    for (;;) {
      const rows = this.database.prepare(`SELECT session_id, sequence, created_at, kind, payload_json, status FROM history
        WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 100`).all(sessionId, after);
      if (!rows.length) return;
      for (const row of rows) {
        const item: HistoryItem = { sessionId: String(row.session_id), sequence: Number(row.sequence),
          createdAt: Number(row.created_at), kind: String(row.kind),
          payload: this.decodeStored(String(row.payload_json)) as Record<string, unknown>, status: String(row.status) };
        await visit(item);
        after = item.sequence;
      }
    }
  }

  deleteSession(id: string): void {
    const deleted = this.transaction(() => {
      const row = this.database.prepare("SELECT owner_token FROM sessions WHERE id = ?").get(id);
      if (!row) return false;
      if (row.owner_token !== null) throw new Error("session is busy in another process");
      for (const item of this.database.prepare("SELECT payload_json FROM history WHERE session_id = ?").all(id)) {
        this.dropPayloadReference(String(item.payload_json));
      }
      for (const item of this.database.prepare("SELECT payload_json FROM model_context WHERE session_id = ?").all(id)) {
        this.dropPayloadReference(String(item.payload_json));
      }
      this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.database.prepare("DELETE FROM store_meta WHERE key = ?").run(nonPeerSchemaKey(id));
      return true;
    });
    if (deleted) {
      try { this.reclaimUnreferencedPayloads(); }
      catch { /* The deletion committed; idle maintenance will retry reclamation. */ }
    }
  }
}

export function openSessionStore(options: SessionStoreOptions = {}): SessionStore { return new SessionStore(options); }
export function sessionStorePath(options: SessionStoreOptions = {}): string { return pathForState(options); }
