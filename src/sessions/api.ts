import { createAgent, type AgentOptions, type AgentSession } from "../agent.js";
import type { StoredPanel } from "../panels/contract.js";
import { openSessionStore, type HistoryItem, type Page, type SessionStoreOptions, type SessionSummary } from "./store.js";

export interface SessionPageOptions {
  cwd?: string;
  before?: string;
  limit?: number;
  storeOptions?: SessionStoreOptions;
}

export interface SessionHistoryOptions {
  sessionId: string;
  before?: string;
  limit?: number;
  storeOptions?: SessionStoreOptions;
}

export interface SessionIdOptions {
  sessionId: string;
  storeOptions?: SessionStoreOptions;
}

export interface ResumeSessionOptions extends SessionIdOptions {
  agentOptions: Omit<AgentOptions, "persistence">;
}

export interface ResumedSession {
  session: SessionSummary;
  agent: AgentSession;
  close(): Promise<void>;
}

export function listSessions(options: SessionPageOptions = {}): Page<SessionSummary> {
  const store = openSessionStore(options.storeOptions);
  try { return store.listSessions({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.before === undefined ? {} : { before: options.before }),
    ...(options.limit === undefined ? {} : { limit: options.limit }) }); }
  finally { store.close(); }
}

export function getSessionHistory(options: SessionHistoryOptions): Page<HistoryItem> {
  const store = openSessionStore(options.storeOptions);
  try { return store.getSessionHistory({ sessionId: options.sessionId,
    ...(options.before === undefined ? {} : { before: options.before }),
    ...(options.limit === undefined ? {} : { limit: options.limit }) }); }
  finally { store.close(); }
}

/** The latest committed tool panels of a saved session (docs/panels-design.md §13.4), oldest first. */
export function getSessionPanels(options: SessionIdOptions): StoredPanel[] {
  const store = openSessionStore(options.storeOptions);
  try {
    if (!store.getSession(options.sessionId)) throw new Error(store.missingSessionMessage());
    return store.listSessionPanels(options.sessionId);
  } finally { store.close(); }
}

export function deleteSession(options: SessionIdOptions): void {
  const store = openSessionStore(options.storeOptions);
  try {
    if (!store.getSession(options.sessionId)) throw new Error(store.missingSessionMessage());
    store.deleteSession(options.sessionId);
  } finally { store.close(); }
}

export function resumeSession(options: ResumeSessionOptions): ResumedSession {
  const store = openSessionStore(options.storeOptions);
  try {
    const session = store.getSession(options.sessionId);
    if (!session) throw new Error(store.missingSessionMessage());
    const agent = createAgent({ ...options.agentOptions, cwd: session.cwd,
      persistence: { store, sessionId: session.id, surface: "cli" } });
    let closed = false;
    return { session: store.getSession(session.id) ?? session, agent, async close() {
      if (closed) return;
      closed = true;
      try { await agent.close(); }
      finally { store.close(); }
    } };
  } catch (error) {
    store.close();
    throw error;
  }
}
