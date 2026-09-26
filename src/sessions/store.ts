import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSessionRetentionDays } from "../config.js";
import type { UsageRecord } from "../llm/cache.js";
import type { ModelMessage, ResolvedModelConfig, UserInput } from "../llm/types.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { SelectedSkill } from "../skills/contract.js";
import { errorResult } from "../tools/results.js";
import { projectToolResult } from "./visible.js";
import { initializeSessionSchema } from "./schema.js";
import { validateStoredAgentState } from "./restore.js";
import { locateSessionStore } from "./location.js";

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
  agentName?: string;
  configPath?: string;
  modelId?: string;
}

export interface CreateSessionOptions {
  cwd: string;
  title: string;
  agentName?: string;
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
  heavySessions: Array<{ id: string; historyItems: number; modelMessages: number; encodedBytes: number; payloadBytes: number; totalBytes: number }>;
}

export interface SessionOwner { token: string; generation: number }
export interface AgentIdentity {
  cwd: string;
  configPath?: string;
  baseToolSelection?: readonly string[];
  selectionExplicit?: boolean;
  system: string;
  modelConfig: Readonly<ResolvedModelConfig>;
  toolDefinitions: readonly ToolDefinition[];
  selectedTools: readonly string[] | null;
  cacheKey: string;
  toolSourceDigest?: string;
  selectedSkills?: readonly SelectedSkill[];
}
export interface SkillSnapshotItem { id: string; name: string; metadataDigest: string; bodyDigest: string }
export interface SkillVisibility { listed: boolean; loaded: readonly string[] }
export interface StoredAgentState {
  messages: ModelMessage[];
  originalTask?: UserInput;
  summaryText?: string;
  cacheKey: string;
  selectedTools: readonly string[] | null;
  contextRevision: number;
  replayBefore: number;
  skillVisibility: SkillVisibility;
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
  contextRevision?: number;
  skillVisibility?: SkillVisibility;
  skillNotice?: string;
  replayBefore?: number;
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

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function snapshotSkills(skills: readonly SelectedSkill[]): SkillSnapshotItem[] {
  return skills.map((skill) => ({ id: skill.id, name: skill.name,
    metadataDigest: digest(JSON.stringify([skill.id, skill.name, skill.description])),
    bodyDigest: digest(skill.markdown) }));
}

function staleSkillNames(previous: readonly SkillSnapshotItem[], current: readonly SkillSnapshotItem[],
  visible: SkillVisibility): string[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  const names = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const next = after.get(id);
    if (visible.listed && old?.metadataDigest !== next?.metadataDigest) names.add(old?.name ?? next!.name);
    if (old && visible.loaded.includes(old.name)
      && (old.bodyDigest !== next?.bodyDigest || old.metadataDigest !== next?.metadataDigest)) names.add(old.name);
  }
  return [...names].sort();
}

function sessionRow(row: DbRow): SessionSummary {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), cwd: String(row.display_path), title: String(row.title),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.agent_name === null ? {} : { agentName: String(row.agent_name) }),
    ...(row.config_path === null ? {} : { configPath: String(row.config_path) }),
    ...(row.model_id === null ? {} : { modelId: String(row.model_id) }),
  };
}

export class SessionStore {
  readonly database: DatabaseSync;
  readonly path: string;
  readonly preservedLegacyPath: string | undefined;
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
    const location = locateSessionStore(options);
    this.path = location.path;
    this.preservedLegacyPath = location.preservedLegacyPath;
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

  missingSessionMessage(): string {
    return `session not found or expired in the active store${this.preservedLegacyPath
      ? `; an older session store was preserved at ${this.preservedLegacyPath}` : ""}`;
  }

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

  private assertMaintenanceIdle(): void {
    const maintenance = this.database.prepare("SELECT value FROM store_meta WHERE key = 'maintenance_owner'").get()?.value;
    if (maintenance === undefined) return;
    if (this.ownerAlive(String(maintenance))) throw new Error("session store is busy with maintenance");
    this.database.prepare("DELETE FROM store_meta WHERE key = 'maintenance_owner'").run();
  }

  claimSession(sessionId: string): SessionOwner {
    return this.transaction(() => {
      this.assertMaintenanceIdle();
      const row = this.database.prepare("SELECT owner_token, owner_generation, lease_until, updated_at FROM sessions WHERE id = ?").get(sessionId);
      if (!row || Number(row.updated_at) <= this.cutoff()) throw new Error(this.missingSessionMessage());
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
    let payloadFiles = 0;
    let payloadBytes = 0;
    const payloadRoot = join(dirname(this.path), "payloads");
    if (existsSync(payloadRoot)) for (const owner of readdirSync(payloadRoot, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const entry of readdirSync(join(payloadRoot, owner.name), { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(payloadRoot, owner.name, entry.name);
        try { payloadBytes += statSync(path).size; payloadFiles++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    const heavy = new Map<string, { id: string; historyItems: number; modelMessages: number; encodedBytes: number; refs: Set<string> }>();
    for (const row of this.database.prepare("SELECT id FROM sessions").all()) {
      const id = String(row.id);
      heavy.set(id, { id, historyItems: 0, modelMessages: 0, encodedBytes: 0, refs: new Set() });
    }
    for (const [table, counter] of [["history", "historyItems"], ["model_context", "modelMessages"]] as const) {
      for (const row of this.database.prepare(`SELECT session_id, payload_json FROM ${table}`).all()) {
        const item = heavy.get(String(row.session_id));
        if (!item) continue;
        item[counter]++;
        const encoded = String(row.payload_json);
        item.encodedBytes += Buffer.byteLength(encoded);
        for (const id of this.payloadIds(encoded)) item.refs.add(id);
      }
    }
    const payloadSize = this.database.prepare("SELECT byte_length FROM payloads WHERE id = ?");
    const heavySessions = [...heavy.values()].map((item) => {
      const referencedBytes = [...item.refs].reduce((sum, id) => sum + Number(payloadSize.get(id)?.byte_length ?? 0), 0);
      return { id: item.id, historyItems: item.historyItems, modelMessages: item.modelMessages,
        encodedBytes: item.encodedBytes, payloadBytes: referencedBytes, totalBytes: item.encodedBytes + referencedBytes };
    }).sort((a, b) => b.totalBytes - a.totalBytes || a.id.localeCompare(b.id)).slice(0, 10);
    return {
      workspaces: count("workspaces"), sessions: count("sessions"), historyItems: count("history"),
      modelMessages: count("model_context"), payloadFiles,
      databaseBytes: bytes(this.path), walBytes: bytes(`${this.path}-wal`),
      payloadBytes, heavySessions,
    };
  }

  getStoredToolView(sessionId: string): { selection: readonly string[] | null; explicit: boolean; baseSelection?: readonly string[] } | undefined {
    const row = this.database.prepare("SELECT selected_tools_json, selection_explicit FROM sessions WHERE id = ?").get(sessionId);
    if (row?.selected_tools_json === null || row?.selected_tools_json === undefined) return undefined;
    const baseSelection = this.runtimeMetadata(sessionId)?.baseSelection;
    return { selection: JSON.parse(String(row.selected_tools_json)) as readonly string[] | null,
      explicit: Number(row.selection_explicit) === 1,
      ...(baseSelection ? { baseSelection } : {}) };
  }

  initializeAgent(sessionId: string, owner: SessionOwner, identity: AgentIdentity): StoredAgentState {
    const canonical = realpathSync(resolve(identity.cwd));
    const toolDigest = digest(JSON.stringify(identity.toolDefinitions));
    const sourceDigest = identity.toolSourceDigest ?? toolDigest;
    const skillSnapshot = snapshotSkills(identity.selectedSkills ?? []);
    const skillSnapshotJson = JSON.stringify(skillSnapshot);
    const endpointHash = digest(identity.modelConfig.baseUrl ?? "");
    const runtimeDigest = digest(JSON.stringify({ request: identity.modelConfig.request ?? null,
      cache: identity.modelConfig.cache ?? null, vision: identity.modelConfig.vision ?? false,
      contextWindow: identity.modelConfig.contextWindow ?? null, maxOutputTokens: identity.modelConfig.maxOutputTokens ?? null }));
    const replaySignature = digest(JSON.stringify({ provider: identity.modelConfig.provider,
      method: identity.modelConfig.method, model: identity.modelConfig.model, endpointHash,
      request: identity.modelConfig.request ?? null, vision: identity.modelConfig.vision ?? false }));
    this.transaction(() => {
      const row = this.ownerRow(sessionId, owner);
      const workspace = this.database.prepare("SELECT canonical_path FROM workspaces WHERE id = ?").get(String(row.workspace_id));
      if (workspace?.canonical_path !== canonical) throw new Error("session cwd changed");
      const previousMeta = this.runtimeMetadata(sessionId);
      if (row.tool_schema_digest === null) {
        this.database.prepare(`UPDATE sessions SET agent_name = ?, model_id = ?, provider = ?, method = ?, endpoint = ?,
          system_prompt = ?, cache_key = ?, selected_tools_json = ?, tool_schema_digest = ?, tool_source_digest = ?,
          skill_snapshot_json = ?, skill_visibility_json = ?, runtime_digest = ?, selection_explicit = ?, config_path = coalesce(?, config_path) WHERE id = ?`)
          .run(identity.modelConfig.agentName, identity.modelConfig.model, identity.modelConfig.provider, identity.modelConfig.method,
            endpointHash, identity.system, row.cache_key === null ? identity.cacheKey : String(row.cache_key),
            JSON.stringify(identity.selectedTools), toolDigest, sourceDigest, skillSnapshotJson,
            JSON.stringify({ listed: false, loaded: [] }), runtimeDigest, identity.selectionExplicit ? 1 : 0,
            identity.configPath ?? null, sessionId);
        this.writeRuntimeMetadata(sessionId, { replayBefore: 0, replaySignature,
          ...(identity.baseToolSelection ? { baseSelection: [...identity.baseToolSelection] } : {}) });
      } else {
        this.recoverInterruptedCallsInTransaction(sessionId, owner);
        const previousState = this.readAgentState(sessionId, owner);
        validateStoredAgentState(previousState);
        const runtimeChanged = row.model_id !== identity.modelConfig.model
          || row.provider !== identity.modelConfig.provider || row.method !== identity.modelConfig.method
          || row.endpoint !== endpointHash || row.system_prompt !== identity.system || row.runtime_digest !== runtimeDigest;
        const toolChanged = row.tool_schema_digest !== toolDigest || row.tool_source_digest !== sourceDigest
          || row.selected_tools_json !== JSON.stringify(identity.selectedTools);
        const toolCatalogChanged = row.tool_schema_digest !== toolDigest || row.selected_tools_json !== JSON.stringify(identity.selectedTools);
        const skillChanged = row.skill_snapshot_json !== skillSnapshotJson;
        const replayChanged = toolCatalogChanged || (previousMeta
          ? previousMeta.replaySignature !== replaySignature
          : runtimeChanged && (row.model_id !== identity.modelConfig.model
            || row.provider !== identity.modelConfig.provider || row.method !== identity.modelConfig.method
            || row.endpoint !== endpointHash || row.runtime_digest !== runtimeDigest));
        if (runtimeChanged || toolChanged || skillChanged) {
          const visibility = JSON.parse(String(row.skill_visibility_json)) as SkillVisibility;
          const previousSkills = JSON.parse(String(row.skill_snapshot_json)) as SkillSnapshotItem[];
          const stale = skillChanged ? staleSkillNames(previousSkills, skillSnapshot, visibility) : [];
          this.database.prepare(`UPDATE sessions SET agent_name = ?, model_id = ?, provider = ?, method = ?, endpoint = ?,
            system_prompt = ?, runtime_digest = ?, selected_tools_json = ?, tool_schema_digest = ?, tool_source_digest = ?,
            skill_snapshot_json = ?, context_revision = context_revision + 1, cache_key = ?, token_calibration = ?,
            selection_explicit = ?, config_path = coalesce(?, config_path) WHERE id = ?`)
            .run(identity.modelConfig.agentName, identity.modelConfig.model, identity.modelConfig.provider,
              identity.modelConfig.method, endpointHash, identity.system, runtimeDigest,
              JSON.stringify(identity.selectedTools), toolDigest, sourceDigest, skillSnapshotJson,
              runtimeChanged || toolChanged ? randomUUID() : String(row.cache_key),
              replayChanged ? 1 : Number(row.token_calibration), identity.selectionExplicit ? 1 : 0,
              identity.configPath ?? null, sessionId);
          this.writeRuntimeMetadata(sessionId, { replayBefore: replayChanged ? previousState.messages.length : previousMeta?.replayBefore ?? 0,
            replaySignature, ...(identity.baseToolSelection ? { baseSelection: [...identity.baseToolSelection] } : {}) });
          const changes = [
            ...(runtimeChanged ? ["runtime"] : []),
            ...(toolCatalogChanged ? ["tools"] : toolChanged ? ["tool source"] : []),
            ...(skillChanged ? ["skills"] : []),
          ];
          const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?")
            .get(sessionId)?.next);
          const transitionText = `Raw resumed with updated ${changes.join(", ")}; earlier calls remain historical.`;
          this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
            .run(sessionId, sequence, this.now(), "runtime_transition", JSON.stringify({ text: transitionText, changes }), "complete");
          if (stale.length) {
            const notice = `[Raw skill reload notice] Stale selected skill information: ${stale.join(", ")}. Call list_skills and load_skill again before relying on earlier results.`;
            const position = Number(this.database.prepare("SELECT coalesce(max(position), -1) + 1 AS next FROM model_context WHERE session_id = ?")
              .get(sessionId)?.next);
            this.database.prepare("INSERT INTO model_context(session_id, position, payload_json) VALUES (?, ?, ?)")
              .run(sessionId, position, JSON.stringify({ role: "user", content: notice }));
            const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?")
              .get(sessionId)?.next);
            this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
              .run(sessionId, sequence, this.now(), "skill_notice", JSON.stringify({ text: notice }), "complete");
            this.database.prepare("UPDATE sessions SET skill_notice_digest = ? WHERE id = ?")
              .run(digest(skillSnapshotJson), sessionId);
          }
        } else {
          if (row.agent_name !== identity.modelConfig.agentName
            || (identity.configPath !== undefined && row.config_path !== identity.configPath)
            || Number(row.selection_explicit) !== (identity.selectionExplicit ? 1 : 0)) {
            this.database.prepare("UPDATE sessions SET agent_name = ?, config_path = coalesce(?, config_path), selection_explicit = ? WHERE id = ?")
              .run(identity.modelConfig.agentName, identity.configPath ?? null, identity.selectionExplicit ? 1 : 0, sessionId);
          }
          if (!previousMeta || JSON.stringify(previousMeta.baseSelection) !== JSON.stringify(identity.baseToolSelection)) {
            this.writeRuntimeMetadata(sessionId, { replayBefore: previousMeta?.replayBefore ?? 0, replaySignature,
              ...(identity.baseToolSelection ? { baseSelection: [...identity.baseToolSelection] } : {}) });
          }
        }
      }
    });
    return this.readAgentState(sessionId, owner);
  }

  readAgentState(sessionId: string, owner: SessionOwner): StoredAgentState {
    const row = this.ownerRow(sessionId, owner);
    const messages = this.database.prepare("SELECT payload_json FROM model_context WHERE session_id = ? ORDER BY position")
      .all(sessionId).map((item) => this.decodeStored(String(item.payload_json)) as ModelMessage);
    const usage = row.usage_json === null ? {} : JSON.parse(String(row.usage_json)) as { rawUsage?: unknown[]; usageEntries?: UsageRecord[] };
    return {
      messages, cacheKey: String(row.cache_key), selectedTools: JSON.parse(String(row.selected_tools_json)) as readonly string[] | null,
      replayBefore: this.runtimeMetadata(sessionId)?.replayBefore ?? 0,
      contextRevision: Number(row.context_revision), tokenCalibration: Number(row.token_calibration),
      skillVisibility: JSON.parse(String(row.skill_visibility_json)) as SkillVisibility,
      rawUsage: usage.rawUsage ?? [], usageEntries: usage.usageEntries ?? [],
      ...(row.original_task === null ? {} : { originalTask: JSON.parse(String(row.original_task)) as UserInput }),
      ...(row.summary_text === null ? {} : { summaryText: String(row.summary_text) }),
    };
  }

  private runtimeMetadata(sessionId: string): { replayBefore: number; replaySignature: string; baseSelection?: readonly string[] } | undefined {
    const row = this.database.prepare("SELECT payload_json FROM session_runtime_metadata WHERE session_id = ?").get(sessionId);
    return row ? JSON.parse(String(row.payload_json)) as { replayBefore: number; replaySignature: string; baseSelection?: readonly string[] } : undefined;
  }

  private writeRuntimeMetadata(sessionId: string, metadata: { replayBefore: number; replaySignature: string; baseSelection?: readonly string[] }): void {
    this.database.prepare(`INSERT INTO session_runtime_metadata(session_id, payload_json) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET payload_json = excluded.payload_json`).run(sessionId, JSON.stringify(metadata));
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
    if (metadata.contextRevision !== undefined) { fields.push("context_revision = ?"); values.push(metadata.contextRevision); }
    if (metadata.skillVisibility !== undefined) { fields.push("skill_visibility_json = ?"); values.push(JSON.stringify(metadata.skillVisibility)); }
    if (metadata.skillNotice !== undefined) { fields.push("skill_notice_digest = ?"); values.push(digest(metadata.skillNotice)); }
    if (fields.length) this.database.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values, sessionId);
    if (metadata.replayBefore !== undefined) {
      const current = this.runtimeMetadata(sessionId);
      this.writeRuntimeMetadata(sessionId, { replayBefore: metadata.replayBefore, replaySignature: current?.replaySignature ?? "",
        ...(current?.baseSelection ? { baseSelection: current.baseSelection } : {}) });
    }
  }

  updateAgentMetadata(sessionId: string, owner: SessionOwner, metadata: AgentMetadata): void {
    this.transaction(() => { this.ownerRow(sessionId, owner); this.writeMetadata(sessionId, metadata); this.renewSession(sessionId, owner); });
  }

  updateAgentToolView(sessionId: string, owner: SessionOwner, selection: readonly string[] | null,
    definitions: readonly ToolDefinition[], revision: number, cacheKey: string, explicit: boolean,
    replayBefore?: number): void {
    this.transaction(() => {
      this.ownerRow(sessionId, owner);
      const toolDigest = digest(JSON.stringify(definitions));
      this.database.prepare(`UPDATE sessions SET selected_tools_json = ?, tool_schema_digest = ?, context_revision = ?,
        cache_key = ?, selection_explicit = ? WHERE id = ?`)
        .run(JSON.stringify(selection), toolDigest, revision, cacheKey, explicit ? 1 : 0, sessionId);
      if (replayBefore !== undefined) {
        const current = this.runtimeMetadata(sessionId);
        this.writeRuntimeMetadata(sessionId, { replayBefore, replaySignature: current?.replaySignature ?? "",
          ...(current?.baseSelection ? { baseSelection: current.baseSelection } : {}) });
      }
      this.renewSession(sessionId, owner);
    });
  }

  private stageBlob(json: string, owner: SessionOwner): StagedPayload {
    const byteLength = Buffer.byteLength(json, "utf8");
    const id = createHash("sha256").update(json).digest("hex");
    const relativePath = join("payloads", owner.token, `${id}-${randomUUID()}.json`);
    this.database.prepare("INSERT INTO staged_payloads(owner_token, relative_path) VALUES (?, ?)")
      .run(owner.token, relativePath);
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
      if (this.database.prepare("SELECT relative_path FROM payloads WHERE id = ?").get(id)?.relative_path === relativePath) {
        this.database.prepare("DELETE FROM staged_payloads WHERE relative_path = ?").run(relativePath);
      }
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
    const stale = this.transaction(() => {
      const rows = this.database.prepare("DELETE FROM payloads WHERE ref_count <= 0 RETURNING relative_path").all();
      const journal = this.database.prepare("INSERT OR IGNORE INTO staged_payloads(owner_token, relative_path) VALUES (?, ?)");
      for (const row of rows) journal.run("reclaim", String(row.relative_path));
      return rows;
    });
    for (const row of stale) {
      const relativePath = String(row.relative_path);
      try { unlinkSync(join(dirname(this.path), relativePath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.database.prepare("DELETE FROM staged_payloads WHERE relative_path = ?").run(relativePath);
    }
  }

  private discardDuplicateStages(values: readonly StagedValue[]): void {
    for (const value of values) for (const payload of value.payloads) {
      const row = this.database.prepare("SELECT relative_path FROM payloads WHERE id = ?").get(payload.id);
      if (row?.relative_path === payload.relativePath) continue;
      try {
        unlinkSync(join(dirname(this.path), payload.relativePath));
        this.database.prepare("DELETE FROM staged_payloads WHERE relative_path = ?").run(payload.relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.database.prepare("DELETE FROM staged_payloads WHERE relative_path = ?").run(payload.relativePath);
        }
        // Any other failed deletion remains in the journal for idle maintenance.
      }
    }
  }

  sweepOrphans(maxEntries = 100): number {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) {
      throw new Error("orphan scan limit must be 1 to 1000");
    }
    const cursorKey = "orphan_scan_cursor";
    const saved = Number(this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(cursorKey)?.value ?? 0);
    const cursor = Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
    const query = this.database.prepare(`SELECT sequence, owner_token, relative_path FROM staged_payloads
      WHERE sequence > ? ORDER BY sequence LIMIT ?`);
    let rows = query.all(cursor, maxEntries);
    if (!rows.length && cursor > 0) rows = query.all(0, maxEntries);
    if (!rows.length) return 0;
    let removed = 0;
    for (const row of rows) {
      const token = String(row.owner_token);
      const relativePath = String(row.relative_path);
      const active = this.database.prepare("SELECT 1 FROM sessions WHERE owner_token = ? LIMIT 1").get(token);
      if (active && this.ownerAlive(token)) continue;
      const referenced = this.database.prepare("SELECT 1 FROM payloads WHERE relative_path = ?").get(relativePath);
      if (!referenced) {
        const absolutePath = join(dirname(this.path), relativePath);
        try { unlinkSync(absolutePath); removed++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { rmdirSync(dirname(absolutePath)); }
        catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      this.database.prepare("DELETE FROM staged_payloads WHERE sequence = ?").run(Number(row.sequence));
    }
    this.database.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(cursorKey, String(rows.at(-1)!.sequence));
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
      if (metadata.skillNotice !== undefined) {
        const sequence = Number(this.database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM history WHERE session_id = ?")
          .get(sessionId)?.next);
        this.database.prepare("INSERT INTO history(session_id, sequence, created_at, kind, payload_json, status) VALUES (?, ?, ?, ?, ?, ?)")
          .run(sessionId, sequence, this.now(), "skill_notice", JSON.stringify({ text: metadata.skillNotice }), "complete");
      }
      if (resetContextMetadata) this.database.prepare(`UPDATE sessions SET original_task = NULL, summary_text = NULL,
        skill_visibility_json = ?, skill_notice_digest = NULL WHERE id = ?`)
        .run(JSON.stringify({ listed: false, loaded: [] }), sessionId);
      this.renewSession(sessionId, owner);
    });
    this.discardDuplicateStages(staged);
    try { this.reclaimUnreferencedPayloads(); }
    catch { /* The context checkpoint committed; idle maintenance will retry reclamation. */ }
  }

  clearAgentContext(sessionId: string, owner: SessionOwner): void {
    this.replaceAgentContext(sessionId, owner, [], { replayBefore: 0 }, true);
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
    this.transaction(() => this.recoverInterruptedCallsInTransaction(sessionId, owner));
  }

  private recoverInterruptedCallsInTransaction(sessionId: string, owner: SessionOwner): void {
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
          .run(sessionId, sequence, this.now(), "tool_result", JSON.stringify({
            display: { ...projectToolResult(call.name, undefined, result), id: call.id },
          }), "interrupted");
      }
      if (unresolved.length) this.renewSession(sessionId, owner);
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
      this.assertMaintenanceIdle();
      const workspace = this.database.prepare("SELECT id FROM workspaces WHERE canonical_path = ?").get(canonical);
      const workspaceId = workspace ? String(workspace.id) : randomUUID();
      if (!workspace) this.database.prepare("INSERT INTO workspaces(id, canonical_path, display_path) VALUES (?, ?, ?)").run(workspaceId, canonical, resolve(options.cwd));
      this.database.prepare(`INSERT INTO sessions(id, workspace_id, title, created_at, updated_at, agent_name,
        config_path, model_id, provider, method, endpoint, system_prompt, cache_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, options.title, timestamp, timestamp,
        options.agentName ?? null, options.configPath ?? null, options.modelId ?? null, options.provider ?? null,
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
      if (!this.getSession(options.sessionId)) throw new Error(this.missingSessionMessage());
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
    if (!this.getSession(options.sessionId)) throw new Error(this.missingSessionMessage());
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
    if (!this.getSession(sessionId)) throw new Error(this.missingSessionMessage());
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
      return true;
    });
    if (deleted) {
      try { this.reclaimUnreferencedPayloads(); }
      catch { /* The deletion committed; idle maintenance will retry reclamation. */ }
    }
  }

  cleanupExpired(maxSessions = 20): number {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) throw new Error("cleanup limit must be 1 to 100");
    const cursorKey = "expiry_scan_cursor";
    let cursor: { updatedAt: number; id: string } | undefined;
    try {
      const saved = this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(cursorKey)?.value;
      if (saved !== undefined) {
        const parsed = JSON.parse(String(saved)) as { updatedAt?: unknown; id?: unknown };
        if (Number.isSafeInteger(parsed.updatedAt) && typeof parsed.id === "string") {
          cursor = { updatedAt: parsed.updatedAt as number, id: parsed.id };
        }
      }
    } catch { /* A malformed maintenance cursor restarts the bounded scan. */ }
    const rows = cursor
      ? this.database.prepare(`SELECT id, updated_at, owner_token, owner_generation FROM sessions
        WHERE updated_at <= ? AND (updated_at, id) > (?, ?) ORDER BY updated_at ASC, id ASC LIMIT ?`)
        .all(this.cutoff(), cursor.updatedAt, cursor.id, maxSessions * 5)
      : this.database.prepare(`SELECT id, updated_at, owner_token, owner_generation FROM sessions
        WHERE updated_at <= ? ORDER BY updated_at ASC, id ASC LIMIT ?`).all(this.cutoff(), maxSessions * 5);
    if (!rows.length) {
      if (cursor) this.database.prepare("DELETE FROM store_meta WHERE key = ?").run(cursorKey);
      return 0;
    }
    let deleted = 0;
    let lastVisited: { updatedAt: number; id: string } | undefined;
    for (const row of rows) {
      if (deleted >= maxSessions) break;
      const id = String(row.id);
      lastVisited = { updatedAt: Number(row.updated_at), id };
      if (row.owner_token !== null) {
        const token = String(row.owner_token);
        if (this.ownerAlive(token)) continue;
        const released = this.database.prepare(`UPDATE sessions SET owner_token = NULL, lease_until = NULL
          WHERE id = ? AND owner_token = ? AND owner_generation = ?`).run(id, token, Number(row.owner_generation));
        if (released.changes !== 1) continue;
      }
      try { this.deleteSession(id); deleted++; }
      catch (error) {
        if (!(error instanceof Error) || !/busy/.test(error.message)) throw error;
      }
    }
    if (rows.length < maxSessions * 5 && deleted < maxSessions) {
      this.database.prepare("DELETE FROM store_meta WHERE key = ?").run(cursorKey);
    } else if (lastVisited) this.database.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(cursorKey, JSON.stringify(lastVisited));
    return deleted;
  }

  reclaimIdleStorage(maxPages = 1024): { checkpointed: boolean; pagesReclaimed: number } {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 8192) throw new Error("reclaim page limit must be 1 to 8192");
    const freePages = Number(this.database.prepare("PRAGMA freelist_count").get()?.freelist_count);
    const pageBytes = Number(this.database.prepare("PRAGMA page_size").get()?.page_size);
    const pendingWalBytes = (() => { try { return statSync(`${this.path}-wal`).size; } catch { return 0; } })();
    if (freePages * pageBytes < 1_048_576 && pendingWalBytes < 1_048_576
      && !this.database.prepare("SELECT 1 FROM payloads WHERE ref_count <= 0 LIMIT 1").get()) {
      return { checkpointed: false, pagesReclaimed: 0 };
    }
    const token = `${process.pid}-${randomUUID()}`;
    const acquired = this.transaction(() => {
      const current = this.database.prepare("SELECT value FROM store_meta WHERE key = 'maintenance_owner'").get()?.value;
      if (current !== undefined) {
        if (this.ownerAlive(String(current))) return false;
        this.database.prepare("DELETE FROM store_meta WHERE key = 'maintenance_owner'").run();
      }
      const claims = this.database.prepare(`SELECT id, owner_token, owner_generation FROM sessions
        WHERE owner_token IS NOT NULL LIMIT 100`).all();
      for (const row of claims) {
        const ownerToken = String(row.owner_token);
        if (this.ownerAlive(ownerToken)) return false;
        this.database.prepare(`UPDATE sessions SET owner_token = NULL, lease_until = NULL
          WHERE id = ? AND owner_token = ? AND owner_generation = ?`)
          .run(String(row.id), ownerToken, Number(row.owner_generation));
      }
      if (this.database.prepare("SELECT 1 FROM sessions WHERE owner_token IS NOT NULL LIMIT 1").get()) return false;
      this.database.prepare("INSERT INTO store_meta(key, value) VALUES ('maintenance_owner', ?)").run(token);
      return true;
    });
    if (!acquired) return { checkpointed: false, pagesReclaimed: 0 };
    try {
      this.reclaimUnreferencedPayloads();
      const before = Number(this.database.prepare("PRAGMA freelist_count").get()?.freelist_count);
      const pageSize = Number(this.database.prepare("PRAGMA page_size").get()?.page_size);
      const walBytes = (() => { try { return statSync(`${this.path}-wal`).size; } catch { return 0; } })();
      if (before * pageSize < 1_048_576 && walBytes < 1_048_576) return { checkpointed: false, pagesReclaimed: 0 };
      const checkpoint = this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint?.busy) !== 0) return { checkpointed: false, pagesReclaimed: 0 };
      if (before * pageSize >= 1_048_576) {
        const mode = Number(this.database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum);
        if (mode === 2) this.database.exec(`PRAGMA incremental_vacuum(${Math.min(before, maxPages)})`);
        else {
          this.database.exec("PRAGMA auto_vacuum = INCREMENTAL");
          this.database.exec("VACUUM");
        }
      }
      const finalCheckpoint = this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const after = Number(this.database.prepare("PRAGMA freelist_count").get()?.freelist_count);
      return { checkpointed: Number(finalCheckpoint?.busy) === 0, pagesReclaimed: Math.max(0, before - after) };
    } finally {
      this.database.prepare("DELETE FROM store_meta WHERE key = 'maintenance_owner' AND value = ?").run(token);
    }
  }
}

export function openSessionStore(options: SessionStoreOptions = {}): SessionStore { return new SessionStore(options); }
export function sessionStorePath(options: SessionStoreOptions = {}): string { return locateSessionStore(options).path; }
