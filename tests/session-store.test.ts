import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore, sessionStorePath } from "../src/sessions/store.js";
import { initializeSessionSchema } from "../src/sessions/schema.js";
import { runSessionMaintenance } from "../src/sessions/maintenance.js";

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

for (const legacyVersion of [2, 4, 999, "unversioned"] as const) {
  test(`unreadable ${legacyVersion} state stays untouched while new sessions use one isolated store`, () => {
    const root = mkdtempSync(join(tmpdir(), "raw-legacy-store-"));
    const env = { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root };
    const legacy = join(root, "raw", "sessions.sqlite");
    mkdirSync(join(root, "raw", "payloads", "historical"), { recursive: true });
    const payload = join(root, "raw", "payloads", "historical", "saved.json");
    writeFileSync(payload, "legacy payload");
    const seed = new DatabaseSync(legacy);
    if (legacyVersion === "unversioned") seed.exec("CREATE TABLE old_messages(id TEXT PRIMARY KEY)");
    else seed.exec(`PRAGMA user_version = ${legacyVersion}`);
    seed.close();
    const originalDb = readFileSync(legacy);
    const options = { env };
    const first = openSessionStore(options);
    const second = openSessionStore(options);
    const expected = join(root, "raw", "stores", "storage-v6", "sessions.sqlite");
    try {
      assert.equal(first.path, expected);
      assert.equal(second.path, expected);
      assert.equal(sessionStorePath(options), expected);
      const id = first.createSession({ cwd: root, title: "fresh" }).id;
      assert.equal(second.getSession(id)?.title, "fresh");
      first.appendHistory({ sessionId: id, kind: "user", payload: { text: "fresh" } });
      assert.equal(second.getSessionHistory({ sessionId: id }).items[0]?.payload.text, "fresh");
      const removable = first.createSession({ cwd: root, title: "temporary" }).id;
      const owner = first.claimSession(removable);
      first.appendOwnedHistory(removable, owner, "tool", { text: "x".repeat(100_000) });
      first.releaseSession(removable, owner);
      assert.ok(first.storageStats().payloadFiles > 0);
      first.deleteSession(removable);
      runSessionMaintenance(first);
      assert.deepEqual(readFileSync(legacy), originalDb);
      assert.equal(readFileSync(payload, "utf8"), "legacy payload");
      assert.equal(statSync(expected).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, "raw", "stores", "storage-v6")).mode & 0o777, 0o700);
    } finally { first.close(); second.close(); }
    const third = openSessionStore(options);
    try { assert.equal(third.listSessions({ cwd: root }).items[0]?.title, "fresh"); }
    finally { third.close(); }
    assert.deepEqual(readFileSync(legacy), originalDb);
  });
}

test("readable format-5 state keeps its existing path and session IDs", () => {
  const { root, store } = fixture();
  const id = store.createSession({ cwd: root, title: "current" }).id;
  store.close();
  const reopened = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    assert.equal(reopened.path, join(root, "raw", "sessions.sqlite"));
    assert.equal(reopened.getSession(id)?.title, "current");
  } finally { reopened.close(); }
});

test("a real legacy-path I/O error is not treated as an old format", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-legacy-io-"));
  const rawRoot = join(root, "raw");
  mkdirSync(join(rawRoot, "sessions.sqlite"), { recursive: true });
  assert.throws(() => openSessionStore({ env: { XDG_STATE_HOME: root } }), /open|directory|SQLITE|I\/O/i);
  assert.equal(statSync(join(rawRoot, "sessions.sqlite")).isDirectory(), true);
});

test("bad saved context row cannot prevent an unrelated new session", () => {
  const { root, store } = fixture();
  try {
    const bad = store.createSession({ cwd: root, title: "bad" }).id;
    store.database.prepare("INSERT INTO model_context(session_id, position, payload_json) VALUES (?, ?, ?)")
      .run(bad, 0, "not-json");
    const good = store.createSession({ cwd: root, title: "good" }).id;
    assert.equal(store.getSession(good)?.title, "good");
    assert.equal(store.listSessions({ cwd: root }).items.length, 2);
  } finally { store.close(); }
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
    assert.equal(first.prepare("PRAGMA user_version").get()?.user_version, 6);
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
