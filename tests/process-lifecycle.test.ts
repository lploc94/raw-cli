import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessions/store.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { ProcessStore, recoverProcessHosts } from "../src/processes/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
import { signalShellGroup } from "../src/tools/process.js";
import { createAcpClient } from "../src/acp/client.js";
import { spawn } from "node:child_process";
import { deleteSession } from "../src/sessions/api.js";
import { createAgent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-process-lifecycle-")); let now = Date.now();
  const options = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }, now: () => now };
  const store = openSessionStore(options); const foreign = openSessionStore(options);
  const session = store.createSession({ cwd: root, title: "process" });
  return { root, store, foreign, session, advance: () => { now += 400 * 86400000; }, close: () => { store.close(); foreign.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("foreign deletion and expiry retain live jobs after the model-turn lease is released", async () => {
  const f = fixture(); const supervisor = new ProcessSupervisor({ store: f.store });
  try {
    const owner = f.store.claimSession(f.session.id); f.store.releaseSession(f.session.id, owner);
    const job = await supervisor.forSession(f.session.id).start({ command: "sleep 30", cwd: f.root });
    assert.throws(() => f.foreign.deleteSession(f.session.id), /busy.*managed processes/);
    f.advance(); assert.equal(f.foreign.cleanupExpired(), 0);
    assert.ok(f.foreign.getSession(f.session.id), "retained live sessions remain addressable");
    assert.ok(f.foreign.listSessions().items.some(session => session.id === f.session.id));
    assert.ok(f.foreign.database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(f.session.id));
    assert.equal(supervisor.forSession(f.session.id).status(job.id).state, "running");
    await supervisor.deleteSession(f.session.id);
    assert.equal(f.foreign.database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(f.session.id), undefined);
  } finally { await supervisor.close(); f.close(); }
});
test("admission and deletion fences serialize both race orders and recover dead ownership without signalling PIDs", () => {
  const f = fixture(); const owner = new ProcessStore(f.store, "owner", 1); const other = new ProcessStore(f.foreign, "other", 1);
  const record = { id: "reserved", sessionId: f.session.id, hostToken: "owner", hostGeneration: 1, revision: 1, state: "starting" as const, command: "true", cwd: f.root, createdAt: Date.now(), updatedAt: Date.now(), earliestCursor: 0, cursor: 0, droppedBytes: 0 };
  try {
    owner.fence(f.session.id);
    assert.throws(() => other.reserve({ ...record, hostToken: "other" }), /deletion/);
    assert.throws(() => f.foreign.deleteSession(f.session.id), /deletion/);
    owner.unfence(f.session.id); owner.reserve(record);
    assert.throws(() => other.fence(f.session.id), /another process host/);
    assert.throws(() => f.foreign.deleteSession(f.session.id), /busy/);
    recoverProcessHosts(f.store.database, Date.now(), () => false);
    assert.equal(owner.read(f.session.id, record.id)!.record.state, "lost");
    assert.throws(() => owner.reserve({ ...record, id: "stale-owner" }), /ownership lost/);
    f.foreign.deleteSession(f.session.id);
    assert.equal(f.store.database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(f.session.id), undefined);
  } finally { f.close(); }
});

test("dashboard process survives runtime teardown and owner deletion cleans it up before removing records", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/process"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "start", type: "function", function: { name: "process", arguments: JSON.stringify({ action: "start", command: "sleep 0.1; printf after-turn; sleep 30" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "started" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "next turn" }, "stop"), openAiDone] },
    { hold: true },
  ] });
  try {
    const session = await f.json<{ id: string }>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const first = await f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "first", kind: "turn", agent: "raw", input: "start" });
    assert.equal((await f.wait(first.id)).state, "completed");
    const context = f.server.context.processes!.forSession(session.id); const job = context.list()[0]!;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(context.status(job.id).state, "running");
    assert.match(context.output(job.id).chunks.map(chunk => chunk.text).join(""), /after-turn/);
    const second = await f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "second", kind: "turn", agent: "raw", input: "continue" });
    assert.equal((await f.wait(second.id)).state, "completed"); assert.equal(context.status(job.id).state, "running");
    const pending = await f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "cancel", kind: "turn", agent: "raw", input: "unrelated turn" });
    for (let i = 0; i < 200 && f.provider.requests.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await f.json(`/operations/${pending.id}/cancel`, "POST"); assert.equal((await f.wait(pending.id)).state, "cancelled");
    assert.equal(context.status(job.id).state, "running", "cancelling another turn does not kill acknowledged work");
    assert.deepEqual(await f.json(`/sessions/${session.id}`, "DELETE"), { deleted: true });
    assert.throws(() => context.status(job.id), /not found/);
  } finally { await f.close(); }
});

for (const surface of ["cli", "acp"] as const) test(`${surface} owns its supervisor until host shutdown and persists confirmed cleanup`, async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/process"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "start", type: "function", function: { name: "process", arguments: '{"action":"start","command":"sleep 30"}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "started" }, "stop"), openAiDone] },
  ] });
  try {
    let sessionId: string;
    if (surface === "acp") {
      const parent = await createAcpClient({ command: process.execPath, args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", f.configPath, "-y"], env: f.env });
      try {
        sessionId = await parent.newSession(f.root); assert.equal((await parent.prompt(sessionId, "start")).stopReason, "end_turn");
        assert.equal(f.server.context.processes!.forSession(sessionId).list()[0]!.state, "running");
      } finally { await parent.close(); }
    } else {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), "--config", f.configPath, "-y", "start"], { cwd: f.root, env: f.env });
      child.stdin.end(); let output = ""; child.stdout.on("data", part => { output += String(part); }); child.stderr.on("data", part => { output += String(part); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      try { assert.equal(await new Promise<number | null>(resolve => child.once("close", resolve)), 0, output); }
      finally { clearTimeout(timer); }
      sessionId = f.server.context.store!.listSessions({ cwd: f.root }).items[0]!.id;
    }
    assert.equal(f.server.context.processes!.forSession(sessionId).list()[0]!.state, "stopped");
  } finally { await f.close(); }
});

test("incomplete owner cleanup retains records and deletion fences can be retried", async () => {
  const f = fixture(); let deny = true;
  const supervisor = new ProcessSupervisor({ store: f.store, signalGroup: (child, signal, platform) => {
    if (deny) throw new Error("fixture permission denied");
    signalShellGroup(child, signal, platform);
  } });
  try {
    const job = await supervisor.forSession(f.session.id).start({ command: "sleep 30", cwd: f.root });
    await assert.rejects(supervisor.deleteSession(f.session.id), /permission denied/);
    assert.ok(f.store.getSession(f.session.id));
    assert.equal(supervisor.forSession(f.session.id).status(job.id).state, "stopping");
    assert.throws(() => f.foreign.deleteSession(f.session.id), /busy/);
    deny = false; await supervisor.deleteSession(f.session.id);
    assert.equal(f.store.getSession(f.session.id), undefined);
  } finally { deny = false; await supervisor.close(); f.close(); }
});

test("durable admission caps the host and terminal retention evicts only oldest terminal rows", () => {
  const f = fixture(); const owner = new ProcessStore(f.store, "bounded", 1);
  const sessions = [f.session, ...Array.from({ length: 4 }, (_, i) => f.store.createSession({ cwd: f.root, title: `s${i}` }))];
  const record = (id: string, sessionId: string, createdAt: number) => ({ id, sessionId, hostToken: "bounded", hostGeneration: 1, revision: 1, state: "starting" as const, command: "fixture", cwd: f.root, createdAt, updatedAt: createdAt, earliestCursor: 0, cursor: 0, droppedBytes: 0 });
  try {
    for (let i = 0; i < 32; i++) owner.reserve(record(`live-${i}`, sessions[Math.floor(i / 8)]!.id, i));
    assert.throws(() => owner.reserve(record("over-host", sessions[4]!.id, 33)), /limit/);
    assert.equal(owner.list(sessions[0]!.id).length, 8);
    for (let i = 0; i < 32; i++) owner.save({ ...record(`live-${i}`, sessions[Math.floor(i / 8)]!.id, i), revision: 2, state: "stopped" }, []);
    for (let i = 0; i < 101; i++) {
      const next = record(`terminal-${i}`, f.session.id, 100 + i); owner.reserve(next);
      owner.save({ ...next, revision: 2, state: "exited" }, []);
    }
    const retained = owner.list(f.session.id); assert.equal(retained.length, 100);
    assert.equal(owner.read(f.session.id, "terminal-0"), undefined); assert.ok(owner.read(f.session.id, "terminal-100"));
  } finally { f.close(); }
});

test("dead-host recovery enforces terminal retention while preserving another live owner's rows", () => {
  const f = fixture(); const owner = new ProcessStore(f.store, "crashed", 1); const liveOwner = new ProcessStore(f.foreign, "still-live", 1);
  const record = (id: string, createdAt: number) => ({ id, sessionId: f.session.id, hostToken: "crashed", hostGeneration: 1, revision: 1, state: "starting" as const, command: "fixture", cwd: f.root, createdAt, updatedAt: createdAt, earliestCursor: 0, cursor: 0, droppedBytes: 0 });
  try {
    for (let i = 0; i < 100; i++) { const next = record(`terminal-${i}`, i); owner.reserve(next); owner.save({ ...next, revision: 2, state: "exited" }, []); }
    for (let i = 0; i < 7; i++) owner.reserve(record(`lost-${i}`, 100 + i));
    liveOwner.reserve({ ...record("live", 108), hostToken: "still-live" });
    f.store.database.prepare("UPDATE process_hosts SET alive = 0 WHERE token = 'crashed'").run();
    recoverProcessHosts(f.store.database, Date.now());
    const retained = liveOwner.list(f.session.id);
    assert.equal(retained.filter(record => record.state !== "starting").length, 100);
    assert.equal(retained.find(record => record.id === "live")!.state, "starting");
    assert.equal(retained.filter(record => record.state === "lost").length, 7);
  } finally { f.close(); }
});

test("public supervised deletion rejects an unbound supervisor and conflicting target-store options", async () => {
  const f = fixture(); const memory = new ProcessSupervisor(); const bound = new ProcessSupervisor({ store: f.store });
  try {
    await assert.rejects(deleteSession({ sessionId: f.session.id, processes: memory }), /persistent.*store|persistent supervisor/);
    assert.ok(f.foreign.getSession(f.session.id));
    await assert.rejects(deleteSession({ sessionId: "missing", processes: bound }), /not found|expired/);
    await assert.rejects(deleteSession({ sessionId: f.session.id, processes: bound, storeOptions: {} }), /storeOptions|one.*store/);
    await deleteSession({ sessionId: f.session.id, processes: bound }); assert.equal(f.foreign.getSession(f.session.id), undefined);
  } finally { await memory.close(); await bound.close(); f.close(); }
});

for (const cause of ["output", "terminal"] as const) test(`${cause} persistence failure preserves ownership and cleans children without uncaught callbacks`, async () => {
  const f = fixture(); const supervisor = new ProcessSupervisor({ store: f.store }); const context = supervisor.forSession(f.session.id);
  try {
    const job = await context.start({ command: cause === "output" ? "sleep 0.05; printf output; sleep 30" : "sleep 0.05; exit 0", cwd: f.root });
    f.store.database.exec("PRAGMA query_only = ON");
    for (let i = 0; i < 250 && !context.status(job.id).error?.includes("persistence"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(context.status(job.id).error ?? "", /persistence/);
    if (cause === "output") {
      for (let i = 0; i < 250 && context.status(job.id).state !== "stopped"; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(context.status(job.id).state, "stopped", "owned handles still complete bounded cleanup while storage is unavailable");
    }
    assert.throws(() => f.foreign.deleteSession(f.session.id), /busy/);
    f.store.database.exec("PRAGMA query_only = OFF"); await supervisor.close();
    assert.ok(["stopped", "exited"].includes(JSON.parse(String(f.foreign.database.prepare("SELECT record_json FROM session_processes WHERE id = ?").get(job.id)!.record_json)).state));
  } finally { f.store.database.exec("PRAGMA query_only = OFF"); await supervisor.close(); f.close(); }
});

test("persisted library agents reject unbound or wrong-store supervisors before ownership or spawn", async () => {
  const f = fixture(); const wrong = fixture(); const memory = new ProcessSupervisor(); const mismatch = new ProcessSupervisor({ store: wrong.store });
  const bound = new ProcessSupervisor({ store: f.foreign }); const registry = new ToolRegistry();
  for (const tool of await loadBundledTools(["process"])) registry.register(tool);
  let calls = 0;
  const provider = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" },
    generate: async () => ++calls === 1 ? { text: "", finishReason: "tool_calls" as const, toolCalls: [{ id: "start", name: "process", arguments: { action: "start", command: "sleep 30" } }] } : { text: "done", finishReason: "stop" as const, toolCalls: [] } };
  const options = { cwd: f.root, provider, registry, persistence: { store: f.store, sessionId: f.session.id, surface: "cli" as const } };
  let agent: ReturnType<typeof createAgent> | undefined;
  try {
    assert.throws(() => createAgent({ ...options, processes: memory }), /same.*session store|bound.*store/);
    assert.throws(() => createAgent({ ...options, processes: mismatch }), /same.*session store|bound.*store/);
    assert.equal(calls, 0); assert.equal(f.store.sessionIsBusy(f.session.id), false);
    assert.equal(memory.forSession(f.session.id).list().length, 0); assert.equal(mismatch.forSession(f.session.id).list().length, 0);
    agent = createAgent({ ...options, processes: bound });
    assert.equal((await agent.run("start")).status, "completed"); await agent.close();
    const job = bound.forSession(f.session.id).list()[0]!; assert.equal(job.state, "running");
    assert.throws(() => f.foreign.deleteSession(f.session.id), /busy/);
    f.advance(); assert.equal(f.foreign.cleanupExpired(), 0); assert.ok(f.foreign.getSession(f.session.id));
    await bound.deleteSession(f.session.id); assert.equal(f.foreign.getSession(f.session.id), undefined);
  } finally { await agent?.close(); await memory.close(); await mismatch.close(); await bound.close(); f.close(); wrong.close(); }
});
