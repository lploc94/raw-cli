import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionMaintenance } from "../src/sessions/maintenance.js";
import { openSessionStore } from "../src/sessions/store.js";

const day = 86_400_000;

test("exact inactivity cutoff hides sessions; reads do not renew but writes do", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-clock-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    const id = store.createSession({ cwd: root, title: "first" }).id;
    now += 7 * day - 1;
    assert.ok(store.getSession(id));
    assert.equal(store.listSessions({ cwd: root }).items.length, 1);
    assert.equal(store.getSessionHistory({ sessionId: id }).items.length, 0);
    now += 1;
    assert.equal(store.getSession(id), undefined);
    assert.equal(store.listSessions({ cwd: root }).items.length, 0);
    assert.throws(() => store.getSessionHistory({ sessionId: id }), /expired/);

    const fresh = store.createSession({ cwd: root, title: "second" }).id;
    now += 7 * day - 1;
    store.appendHistory({ sessionId: fresh, kind: "user", payload: { input: "activity" } });
    now += 1;
    assert.ok(store.getSession(fresh));
    assert.equal(store.getSessionHistory({ sessionId: fresh }).items.length, 1);
  } finally { store.close(); }
});

test("idle cleanup skips live claims, then removes expired rows and referenced payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-cleanup-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    const id = store.createSession({ cwd: root, title: "large" }).id;
    const owner = store.claimSession(id);
    store.appendOwnedHistory(id, owner, "tool_call", { arguments: "x".repeat(100_000) });
    const before = store.storageStats();
    assert.ok(before.payloadBytes > 90_000);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM staged_payloads").get()?.n), 0);
    now += 7 * day;
    assert.equal(runSessionMaintenance(store).expiredDeleted, 0);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(id)?.n), 1);
    store.releaseSession(id, owner);
    assert.equal(runSessionMaintenance(store).expiredDeleted, 1);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(id)?.n), 0);
    assert.equal(store.storageStats().payloadBytes, 0);
    assert.equal(store.storageStats().payloadFiles, 0);
    assert.ok(existsSync(store.path));
  } finally { store.close(); }
});

test("failed publication leaves a bounded journal entry for later orphan cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-stage-failure-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const id = store.createSession({ cwd: root, title: "failed-stage" }).id;
    const owner = store.claimSession(id);
    store.database.exec("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'simulated'); END");
    assert.throws(() => store.appendOwnedHistory(id, owner, "status", { text: "x".repeat(100_000) }), /simulated/);
    store.database.exec("DROP TRIGGER reject_history");
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM staged_payloads").get()?.n), 1);
    assert.equal(store.storageStats().payloadFiles, 1);
    store.releaseSession(id, owner);
    assert.equal(runSessionMaintenance(store, { reclaim: false }).orphanFilesDeleted, 1);
    assert.equal(store.storageStats().payloadFiles, 0);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM staged_payloads").get()?.n), 0);
  } finally { store.close(); }
});

test("failed payload unlink remains journalled and is retried by idle maintenance", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-unlink-failure-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const id = store.createSession({ cwd: root, title: "unlink-failure" }).id;
    const owner = store.claimSession(id);
    store.appendOwnedHistory(id, owner, "status", { text: "x".repeat(100_000) });
    store.releaseSession(id, owner);
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (path) => {
      if (String(path).includes("payloads")) throw Object.assign(new Error("simulated unlink failure"), { code: "EACCES" });
      unlink(path);
    };
    syncBuiltinESMExports();
    try { store.deleteSession(id); }
    finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
    assert.equal(store.storageStats().payloadFiles, 1);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM staged_payloads").get()?.n), 1);
    assert.equal(runSessionMaintenance(store, { reclaim: false }).orphanFilesDeleted, 1);
    assert.equal(store.storageStats().payloadFiles, 0);
  } finally { store.close(); }
});

test("idle maintenance reclaims SQLite free pages and stats identify the heaviest sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-pages-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    const large = store.createSession({ cwd: root, title: "large" }).id;
    const small = store.createSession({ cwd: root, title: "small" }).id;
    for (let index = 0; index < 80; index++) store.appendHistory({ sessionId: large, kind: "status", payload: { text: "x".repeat(50_000) } });
    store.appendHistory({ sessionId: small, kind: "status", payload: { text: "small" } });
    const occupied = store.storageStats();
    assert.equal(occupied.heavySessions[0]?.id, large);
    assert.ok(occupied.databaseBytes + occupied.walBytes > 2_000_000);
    now += 7 * day;
    const cleanup = runSessionMaintenance(store, { maxSessions: 100 });
    assert.equal(cleanup.expiredDeleted, 2);
    const after = store.storageStats();
    assert.equal(after.sessions, 0);
    assert.ok(after.databaseBytes + after.walBytes < occupied.databaseBytes + occupied.walBytes);
  } finally { store.close(); }
});

test("two separate agent processes obey one canonical retention setting", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-canonical-"));
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "raw"), { recursive: true });
  writeFileSync(join(configHome, "raw", "config.json"), '{"sessions":{"retention_days":1}}');
  const env = { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: configHome };
  const now = 1_800_000_000_000;
  const store = openSessionStore({ env, now: () => now });
  const id = store.createSession({ cwd: root, title: "canonical" }).id;
  store.close();
  const configs = [join(root, "first.json"), join(root, "second.json")];
  for (const path of configs) writeFileSync(path, JSON.stringify({ default_agent: "local",
    models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: path } },
    agents: { local: { model: "local", tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash"] } } } }));
  for (const [index, path] of configs.entries()) {
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      join(process.cwd(), "tests/fixtures/retention-worker.ts"), path, id,
      String(now + day - (index === 0 ? 1 : 0))], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { retentionDays: 1, visible: index === 0 });
  }
});

test("cleanup removes a dead owner's expired session and only dead-owner orphan files", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-orphans-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    const dead = store.createSession({ cwd: root, title: "dead" }).id;
    const live = store.createSession({ cwd: root, title: "live" }).id;
    const liveOwner = store.claimSession(live);
    const deadToken = "2147483647-dead-owner";
    store.database.prepare("UPDATE sessions SET owner_token = ?, lease_until = ? WHERE id = ?").run(deadToken, now - 1, dead);
    const payloadRoot = join(root, "raw", "payloads");
    mkdirSync(join(payloadRoot, deadToken), { recursive: true });
    mkdirSync(join(payloadRoot, liveOwner.token), { recursive: true });
    const deadFile = join(payloadRoot, deadToken, "orphan.json");
    const liveFile = join(payloadRoot, liveOwner.token, "unpublished.json");
    writeFileSync(deadFile, "dead");
    writeFileSync(liveFile, "live");
    store.database.prepare("INSERT INTO staged_payloads(owner_token, relative_path) VALUES (?, ?)")
      .run(deadToken, join("payloads", deadToken, "orphan.json"));
    store.database.prepare("INSERT INTO staged_payloads(owner_token, relative_path) VALUES (?, ?)")
      .run(liveOwner.token, join("payloads", liveOwner.token, "unpublished.json"));
    assert.equal(store.storageStats().payloadBytes, 8);
    now += 7 * day;
    assert.equal(runSessionMaintenance(store).expiredDeleted, 1);
    assert.equal(existsSync(deadFile), false);
    assert.equal(existsSync(liveFile), true);
    assert.equal(store.storageStats().payloadBytes, 4);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(live)?.n), 1);
    store.releaseSession(live, liveOwner);
    assert.equal(runSessionMaintenance(store).expiredDeleted, 1);
    assert.equal(existsSync(liveFile), false);
    assert.equal(store.storageStats().payloadBytes, 0);
  } finally { store.close(); }
});

test("orphan sweeping budgets staged rows and reaches a dead owner's file after many live rows", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-orphan-budget-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const live = store.createSession({ cwd: root, title: "live-stage" }).id;
    const owner = store.claimSession(live);
    const liveDirectory = join(root, "raw", "payloads", owner.token);
    mkdirSync(liveDirectory, { recursive: true });
    const insert = store.database.prepare("INSERT INTO staged_payloads(owner_token, relative_path) VALUES (?, ?)");
    for (let index = 0; index < 250; index++) {
      const filename = `${String(index).padStart(3, "0")}.json`;
      writeFileSync(join(liveDirectory, filename), "x");
      insert.run(owner.token, join("payloads", owner.token, filename));
    }
    const token = "2147483647-orphan-budget";
    const directory = join(root, "raw", "payloads", token);
    mkdirSync(directory, { recursive: true });
    const orphan = join(directory, "zzz-orphan.json");
    writeFileSync(orphan, "x");
    insert.run(token, join("payloads", token, "zzz-orphan.json"));
    for (let pass = 0; pass < 6; pass++) {
      assert.equal(runSessionMaintenance(store, { maxOrphanEntries: 40, reclaim: false }).orphanFilesDeleted, 0);
      assert.equal(existsSync(orphan), true);
    }
    assert.equal(runSessionMaintenance(store, { maxOrphanEntries: 40, reclaim: false }).orphanFilesDeleted, 1);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(join(liveDirectory, "000.json")), true);
    store.releaseSession(live, owner);
    assert.match(String(store.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM payloads WHERE relative_path = ?")
      .all("unused")[0]?.detail), /USING .*INDEX/i);
  } finally { store.close(); }
});

test("compacted model-only payloads disappear while every large visible item still pages", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-compact-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const id = store.createSession({ cwd: root, title: `large-${index}` }).id;
      ids.push(id);
      const owner = store.claimSession(id);
      store.initializeAgent(id, owner, { cwd: root, system: "system",
        modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
        toolDefinitions: [], selectedTools: null, cacheKey: `key-${index}` });
      store.appendAgentMessage(id, owner, { role: "user", content: `model-${index}-` + "m".repeat(70_000) }, {}, [
        { kind: "tool_call", payload: { id: `call-${index}`, name: "bash",
          arguments: `visible-${index}-` + "v".repeat(70_000), started: true } },
      ]);
      store.releaseSession(id, owner);
    }
    const before = store.storageStats();
    assert.ok(before.payloadBytes > 800_000);
    for (const id of ids) {
      const owner = store.claimSession(id);
      store.replaceAgentContext(id, owner, [{ role: "user", content: "[Conversation summary]" }], { summaryText: "summary" });
      store.releaseSession(id, owner);
    }
    const after = store.storageStats();
    assert.ok(after.payloadBytes < before.payloadBytes - 400_000);
    assert.ok(after.payloadBytes > 400_000);
    for (const [index, id] of ids.entries()) {
      const page = store.getSessionHistory({ sessionId: id });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.payload.arguments, `visible-${index}-` + "v".repeat(70_000));
    }
  } finally { store.close(); }
});

test("bounded cleanup advances past many still-live expired claims", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-fair-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  const owners: Array<{ id: string; token: string; generation: number }> = [];
  try {
    for (let index = 0; index < 11; index++) {
      const id = store.createSession({ cwd: root, title: `live-${index}` }).id;
      owners.push({ id, ...store.claimSession(id) });
    }
    const removable = store.createSession({ cwd: root, title: "removable" }).id;
    now += 7 * day;
    let deleted = 0;
    for (let attempt = 0; attempt < 5; attempt++) deleted += runSessionMaintenance(store,
      { maxSessions: 1, sweepOrphans: false, reclaim: false }).expiredDeleted;
    assert.equal(deleted, 1);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(removable)?.n), 0);
    assert.equal(Number(store.database.prepare("SELECT count(*) AS n FROM sessions").get()?.n), 11);
  } finally {
    for (const owner of owners) store.releaseSession(owner.id, owner);
    store.close();
  }
});

test("legacy non-incremental SQLite store converts only during idle reclamation", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-legacy-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    store.database.exec("PRAGMA auto_vacuum = NONE");
    store.database.exec("VACUUM");
    assert.equal(Number(store.database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum), 0);
    const id = store.createSession({ cwd: root, title: "legacy" }).id;
    for (let index = 0; index < 60; index++) store.appendHistory({ sessionId: id, kind: "status",
      payload: { text: `legacy-${index}-` + "x".repeat(50_000) } });
    const before = store.storageStats().databaseBytes + store.storageStats().walBytes;
    now += 7 * day;
    assert.equal(runSessionMaintenance(store).expiredDeleted, 1);
    assert.equal(Number(store.database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum), 2);
    assert.ok(store.storageStats().databaseBytes + store.storageStats().walBytes < before);
  } finally { store.close(); }
});

test("a live maintenance fence prevents a new writer during file reclamation", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-fence-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  try {
    const id = store.createSession({ cwd: root, title: "fenced" }).id;
    const token = `${process.pid}-maintenance-test`;
    store.database.prepare("INSERT INTO store_meta(key, value) VALUES ('maintenance_owner', ?)").run(token);
    assert.throws(() => store.claimSession(id), /maintenance/i);
    store.database.prepare("DELETE FROM store_meta WHERE key = 'maintenance_owner'").run();
    const owner = store.claimSession(id);
    store.releaseSession(id, owner);
  } finally { store.close(); }
});

test("a dead claim on a recent session does not block unrelated expired-page reclamation", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-retention-dead-claim-"));
  let now = 1_800_000_000_000;
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now });
  try {
    const expired = store.createSession({ cwd: root, title: "expired-large" }).id;
    for (let index = 0; index < 80; index++) store.appendHistory({ sessionId: expired, kind: "status",
      payload: { text: `row-${index}-` + "x".repeat(50_000) } });
    now += 8 * day;
    const recent = store.createSession({ cwd: root, title: "recent-dead" }).id;
    store.database.prepare("UPDATE sessions SET owner_token = ?, owner_generation = 1, lease_until = ? WHERE id = ?")
      .run("2147483647-dead-process", now - 1, recent);
    const result = runSessionMaintenance(store);
    assert.equal(result.expiredDeleted, 1);
    assert.ok(result.pagesReclaimed > 0);
    assert.ok(store.getSession(recent));
    assert.equal(store.database.prepare("SELECT owner_token FROM sessions WHERE id = ?").get(recent)?.owner_token, null);
  } finally { store.close(); }
});
