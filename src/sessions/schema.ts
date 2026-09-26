import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SESSION_SCHEMA_VERSION = 5;

export function initializeSessionSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (Number(database.prepare("PRAGMA user_version").get()?.user_version) === 0
    && !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 0 && version !== SESSION_SCHEMA_VERSION) {
      throw new Error(`unsupported session schema version: ${version}`);
    }
    if (version === 0) {
      const existing = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (existing) throw new Error("unsupported session schema version: unversioned database");
      const storeId = randomUUID();
      database.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        display_path TEXT NOT NULL
      );
      CREATE TABLE store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO store_meta(key, value) VALUES ('id', '${storeId}');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        agent_name TEXT,
        config_path TEXT,
        model_id TEXT,
        provider TEXT,
        method TEXT,
        endpoint TEXT,
        system_prompt TEXT,
        cache_key TEXT,
        selected_tools_json TEXT,
        tool_schema_digest TEXT,
        tool_source_digest TEXT,
        skill_snapshot_json TEXT,
        skill_visibility_json TEXT,
        skill_notice_digest TEXT,
        selection_explicit INTEGER NOT NULL DEFAULT 0,
        runtime_digest TEXT,
        original_task TEXT,
        summary_text TEXT,
        usage_json TEXT,
        token_calibration REAL NOT NULL DEFAULT 1,
        context_revision INTEGER NOT NULL DEFAULT 1,
        owner_token TEXT,
        owner_generation INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER
      );
      CREATE INDEX sessions_workspace_updated ON sessions(workspace_id, updated_at DESC, id DESC);
      CREATE INDEX sessions_updated ON sessions(updated_at DESC, id DESC);
      CREATE TABLE history (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(session_id, sequence)
      );
      CREATE INDEX history_session_sequence ON history(session_id, sequence DESC);
      CREATE TABLE model_context (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(session_id, position)
      );
      CREATE TABLE payloads (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 5;
    `);
    }
    database.exec("CREATE INDEX IF NOT EXISTS payloads_relative_path ON payloads(relative_path)");
    database.exec(`CREATE TABLE IF NOT EXISTS staged_payloads (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_token TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS session_runtime_metadata (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS session_operations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      committed_user_position INTEGER,
      payload_json TEXT NOT NULL,
      UNIQUE(session_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS session_operations_recent ON session_operations(session_id, updated_at DESC, id DESC);`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database.exec("PRAGMA journal_mode = WAL");
}
