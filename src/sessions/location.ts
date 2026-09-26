import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStoreOptions } from "./store.js";
import { SESSION_SCHEMA_VERSION } from "./schema.js";

export interface SessionLocation {
  path: string;
  preservedLegacyPath?: string;
}

function legacyPath(options: SessionStoreOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const base = env.XDG_STATE_HOME ? resolve(cwd, env.XDG_STATE_HOME) : join(options.home ?? homedir(), ".local", "state");
  return join(base, "raw", "sessions.sqlite");
}

function compatible(path: string): boolean {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version === SESSION_SCHEMA_VERSION) return true;
    if (version !== 0) return false;
    return !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  } finally { database.close(); }
}

export function locateSessionStore(options: SessionStoreOptions): SessionLocation {
  const legacy = legacyPath(options);
  const family = join(dirname(legacy), "stores", `storage-v${SESSION_SCHEMA_VERSION}`, "sessions.sqlite");
  if (existsSync(family)) return { path: family, ...(existsSync(legacy) ? { preservedLegacyPath: legacy } : {}) };
  if (!existsSync(legacy) || compatible(legacy)) return { path: legacy };
  return { path: family, preservedLegacyPath: legacy };
}
