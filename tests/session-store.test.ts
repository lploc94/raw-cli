import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore } from "../src/sessions/store.js";
import { initializeSessionSchema } from "../src/sessions/schema.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-sessions-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  return { root, store, setNow: (value: number) => { now = value; } };
}

test("one private global DB and deterministic 1001-session keyset pages", () => {
  const { root, store } = fixture();
  try {
    const workspaceA = join(root, "a");
    const workspaceB = join(root, "b");
    // The state root exists; workspace roots must also exist.
    mkdirSync(workspaceA); mkdirSync(workspaceB);
    const created: string[] = [];
    for (let i = 0; i < 1001; i++) {
      created.push(store.createSession({ cwd: i % 2 ? workspaceA : workspaceB, title: `task ${i}` }).id);
    }
    const ids: string[] = [];
    let before: string | undefined;
    do {
      const page = store.listSessions({ limit: 37, ...(before ? { before } : {}) });
      assert.ok(page.items.length <= 37);
      ids.push(...page.items.map((item) => item.id));
      before = page.nextCursor;
    } while (before);
    assert.equal(ids.length, 1001);
    assert.equal(new Set(ids).size, 1001);
    assert.deepEqual([...ids].sort().reverse(), ids);
    assert.deepEqual([...created].sort(), [...ids].sort());
    const pageA = store.listSessions({ cwd: workspaceA, limit: 100 });
    assert.equal(pageA.items.length, 100);
    assert.ok(pageA.items.every((item) => item.cwd === workspaceA));
    assert.throws(() => store.listSessions({ cwd: workspaceB, before: pageA.nextCursor! }), /cursor/i);
    assert.throws(() => store.listSessions({ before: "broken" }), /cursor/i);
    assert.throws(() => store.listSessions({ before: pageA.nextCursor! + "!" }), /cursor/i);
    const other = fixture();
    try { assert.throws(() => other.store.listSessions({ cwd: workspaceA, before: pageA.nextCursor! }), /cursor/i); }
    finally { other.store.close(); }
    const indexes = store.database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => String(row.name));
    assert.ok(indexes.some((name) => name.includes("workspace_updated")));
    assert.ok(indexes.some((name) => name.includes("sessions_updated")));
    assert.equal(statSync(join(root, "raw")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "raw", "sessions.sqlite")).mode & 0o777, 0o600);
  } finally { store.close(); }
});

test("newest 20 history items page backward through all 41 and deletion cascades", () => {
  const { root, store, setNow } = fixture();
  try {
    const session = store.createSession({ cwd: root, title: "hello" });
    for (let i = 1; i <= 41; i++) {
      setNow(1_800_000_000_000 + i);
      store.appendHistory({ sessionId: session.id, kind: "assistant", payload: { text: `answer ${i}` }, status: "complete" });
    }
    const first = store.getSessionHistory({ sessionId: session.id });
    assert.deepEqual(first.items.map((item) => item.sequence), Array.from({ length: 20 }, (_, i) => i + 22));
    const second = store.getSessionHistory({ sessionId: session.id, before: first.nextCursor! });
    assert.deepEqual(second.items.map((item) => item.sequence), Array.from({ length: 20 }, (_, i) => i + 2));
    const third = store.getSessionHistory({ sessionId: session.id, before: second.nextCursor! });
    assert.deepEqual(third.items.map((item) => item.sequence), [1]);
    assert.equal(third.nextCursor, undefined);
    assert.throws(() => store.getSessionHistory({ sessionId: "other", before: first.nextCursor! }), /cursor/i);
    store.deleteSession(session.id);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM history").get()?.n, 0);
  } finally { store.close(); }
});

test("unsupported schema version fails without altering the database", () => {
  const { root, store } = fixture();
  const path = join(root, "raw", "sessions.sqlite");
  store.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 999");
  db.close();
  assert.throws(() => openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } }), /schema version/i);
  const verify = new DatabaseSync(path);
  assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 999);
  verify.close();
});

test("independent reader sees committed writes without blocking", () => {
  const { root, store } = fixture();
  const reader = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const id = store.createSession({ cwd: root, title: "concurrent" }).id;
    assert.equal(reader.listSessions().items[0]?.id, id);
    store.appendHistory({ sessionId: id, kind: "user", payload: { text: "hello" } });
    assert.equal(reader.getSessionHistory({ sessionId: id }).items[0]?.payload.text, "hello");
  } finally { reader.close(); store.close(); }
});

test("a second opener winning the first-schema race does not break the first", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-schema-race-"));
  const path = join(root, "sessions.sqlite");
  const first = new DatabaseSync(path);
  const second = new DatabaseSync(path);
  const originalExec = first.exec.bind(first);
  let overlapped = false;
  first.exec = (sql: string) => {
    if (!overlapped && sql.includes("BEGIN IMMEDIATE")) {
      overlapped = true;
      initializeSessionSchema(second);
    }
    return originalExec(sql);
  };
  try {
    initializeSessionSchema(first);
    assert.equal(first.prepare("PRAGMA user_version").get()?.user_version, 5);
  } finally { first.close(); second.close(); }
});

test("relative XDG config resolves against the supplied store cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-cwd-"));
  mkdirSync(join(root, "settings", "raw"), { recursive: true });
  writeFileSync(join(root, "settings", "raw", "config.json"), JSON.stringify({ sessions: { retention_days: 1 } }));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ cwd: root, env: { XDG_STATE_HOME: "state", XDG_CONFIG_HOME: "settings" }, now: () => now });
  try {
    const id = store.createSession({ cwd: root, title: "expires" }).id;
    now += 2 * 86_400_000;
    assert.equal(store.getSession(id), undefined);
  } finally { store.close(); }
});

test("older history and workspace pages seek into their composite indexes", () => {
  const { root, store } = fixture();
  try {
    const session = store.createSession({ cwd: root, title: "seek" });
    for (let i = 0; i < 41; i++) store.appendHistory({ sessionId: session.id, kind: "user", payload: { text: String(i) } });
    const historyCursor = store.getSessionHistory({ sessionId: session.id }).nextCursor!;
    const originalPrepare = store.database.prepare.bind(store.database);
    const queries: string[] = [];
    store.database.prepare = (sql: string) => { queries.push(sql); return originalPrepare(sql); };
    store.getSessionHistory({ sessionId: session.id, before: historyCursor });
    const historySql = queries.find((sql) => sql.includes("FROM history") && sql.includes("ORDER BY"))!;
    const historyPlan = originalPrepare("EXPLAIN QUERY PLAN " + historySql).all(session.id, 21, 21)
      .map((row) => String(row.detail)).join(" ");
    assert.match(historyPlan, /sequence</);
    queries.length = 0;
    store.listSessions({ cwd: root });
    const listSql = queries.find((sql) => sql.includes("FROM sessions") && sql.includes("ORDER BY"))!;
    assert.match(listSql, /workspace_id\s*=/);
  } finally { store.close(); }
});
