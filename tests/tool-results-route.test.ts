import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type AgentOptions } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { startDashboard } from "../src/dashboard/server.js";
import { effectiveInputBudget } from "../src/llm/context.js";
import { effectiveOutputTokens } from "../src/llm/output.js";
import type { ProviderAdapter, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore, type SessionStore } from "../src/sessions/store.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SPILL_MAX_BYTES } from "../src/tools/spill.js";

const wide: Partial<ResolvedModelConfig> = { contextWindow: 200000, maxOutputTokens: 1000 };
const budget = effectiveInputBudget(wide.contextWindow!, effectiveOutputTokens(wide as ResolvedModelConfig));
const call = (id: string, name: string, args: Record<string, unknown>): ProviderTurn =>
  ({ text: "", toolCalls: [{ id, name, arguments: args }], finishReason: "tool_calls" });
const stop = (text: string): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop" });

/** `failCompaction`: every compaction request fails, so crossing the trigger runs the fallback chain, which clears old tool results. */
function scripted(script: ProviderTurn[], failCompaction = false): ProviderAdapter {
  return { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions", model: "fixture", ...wide },
    async generate(request) {
      const compaction = request.system === COMPACT_SYSTEM_PROMPT || request.maxOutputTokens !== undefined;
      if (compaction && failCompaction) throw new Error("summarizer down");
      return request.system === COMPACT_SYSTEM_PROMPT ? stop("## Goal\nsummary") : script.shift() ?? stop("done");
    } };
}

const SEQ = Array.from({ length: 30000 }, (_, index) => `${index + 1}\n`).join("");
const ROWS = Array.from({ length: 400 }, (_, index) => ({ index, label: `row-${index}`, tags: ["a", "b"] }));
const probeText = (id: string) => `${id}${"r".repeat(41000)}`;

async function tools(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  for (const tool of await loadBundledTools(["bash"])) registry.register(tool);
  registry.register({ name: "rows", description: "rows", inputSchema: { type: "object", properties: { count: { type: "integer" } } },
    handler: async (args) => ({ isError: false, content: [{ type: "json", value: { rows: ROWS.slice(0, Number(args.count)) } }] }) });
  registry.register({ name: "flood", description: "flood", inputSchema: { type: "object", properties: {} },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "y".repeat(SPILL_MAX_BYTES + 4096) }] }) });
  // Probe results stay whole in the context so clearing, not capping, is what saves them.
  registry.register({ name: "probe", description: "probe", inputSchema: { type: "object", properties: { out: { type: "string" } } }, outputLimit: 100000,
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: probeText(String(args.out)) }] }) });
  return registry;
}

/** Every saved-output directory under the temp root, with each file's size and modification time. */
function spillListing(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("raw-output-")).sort().flatMap((dir) => {
    try {
      return readdirSync(join(tmpdir(), dir)).sort().map((file) => {
        const stat = statSync(join(tmpdir(), dir, file)); return `${dir}/${file}:${stat.size}:${stat.mtimeMs}`;
      });
    } catch { return [`${dir}:unreadable`]; }
  });
}

interface Fixture { root: string; env: NodeJS.ProcessEnv; configPath: string; producers: string; clearing: string; cleared: { a: string; b: string } }

/** Two persisted sessions produced by real runs: capped and spilled results in one, two context clearings in the other. */
async function produce(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-results-route-"));
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") };
  const configPath = join(root, "config", "raw", "config.json");
  mkdirSync(join(root, "config", "raw"), { recursive: true }); writeFileSync(configPath, "{}");
  const store = openSessionStore({ cwd: root, env });
  try {
    const registry = await tools();
    const producers = store.createSession({ cwd: root, title: "producers" }).id;
    const first = createAgent({ cwd: root, provider: scripted([call("bash-1", "bash", { command: "seq 1 30000" }), call("rows-1", "rows", { count: 400 }),
      call("rows-small", "rows", { count: 1 }), call("flood-1", "flood", {}), stop("done")]), system: "tiny", autoApprove: true, registry, maxSteps: 20,
    maxOutputBytes: 4096, whitelist: ["bash", "rows", "flood"], persistence: { store, sessionId: producers, surface: "web" } });
    try { assert.equal((await first.run("go")).status, "completed"); } finally { await first.close(); }

    const clearing = store.createSession({ cwd: root, title: "clearing" }).id;
    const options: Partial<AgentOptions> = { registry, maxSteps: 40, whitelist: ["probe"],
      compact: { keepRecentTurns: 2, keepRecentTokens: 1000, maxOutputTokens: 1000, triggerTokens: 100000 } };
    const second = createAgent({ cwd: root, provider: scripted(Array.from({ length: 24 }, (_, index) => call(`p${index}`, "probe", { out: `p${index}` })), true),
      system: "tiny", autoApprove: true, ...options, persistence: { store, sessionId: clearing, surface: "web" } });
    try { assert.equal((await second.run("go")).status, "completed"); } finally { await second.close(); }
    const records = store.getSessionHistory({ sessionId: clearing, limit: 100 }).items.filter((item) => item.kind === "context_clearing")
      .map((item) => (item.payload.results as Array<{ callId: string }>).map((entry) => entry.callId));
    assert.ok(records.length >= 2, `clearing records: ${JSON.stringify(records)}`);
    // A is cleared by the first record, B only by the last, so finding A means searching past newer records.
    const a = records[0]![0]!; const b = records.at(-1)!.at(-1)!;
    assert.ok(!records.slice(1).flat().includes(a) && !records.slice(0, -1).flat().includes(b));
    return { root, env, configPath, producers, clearing, cleared: { a, b } };
  } finally { store.close(); }
}

async function serve<T>(fixture: Fixture, run: (get: (session: string, callId: string, auth?: boolean) => Promise<Response>) => Promise<T>): Promise<T> {
  const server = await startDashboard({ port: 0, cwd: fixture.root, configPath: fixture.configPath, env: fixture.env });
  try {
    return await run((session, callId, auth = true) => fetch(`${server.url}/api/sessions/${encodeURIComponent(session)}/tool-results/${encodeURIComponent(callId)}/full`,
      { headers: auth ? { Authorization: `Bearer ${server.token}` } : {} }));
  } finally { await server.close(); }
}

async function compactBoth(fixture: Fixture): Promise<void> {
  const store: SessionStore = openSessionStore({ cwd: fixture.root, env: fixture.env });
  try {
    for (const sessionId of [fixture.producers, fixture.clearing]) {
      const agent = createAgent({ cwd: fixture.root, provider: scripted([]), system: "tiny", autoApprove: true, registry: await tools(),
        persistence: { store, sessionId, surface: "web" } });
      try { assert.equal((await agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1 })).status, "compacted"); } finally { await agent.close(); }
    }
  } finally { store.close(); }
}

test("full results from bash, capping and two clearings are served byte-exact and read-only across restart and compaction", async () => {
  const fixture = await produce();
  const expected: Array<[string, string, string, boolean]> = [
    [fixture.producers, "bash-1", SEQ, false],
    [fixture.producers, "rows-1", JSON.stringify({ rows: ROWS }, null, 2), false],
    [fixture.producers, "flood-1", "y".repeat(SPILL_MAX_BYTES), true],
    [fixture.clearing, fixture.cleared.a, probeText(fixture.cleared.a), false],
    [fixture.clearing, fixture.cleared.b, probeText(fixture.cleared.b), false],
  ];
  const check = (label: string) => serve(fixture, async (get) => {
    const before = spillListing();
    for (const [session, callId, body, capped] of expected) {
      const response = await get(session, callId);
      assert.equal(response.status, 200, `${label} ${callId}`);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(response.headers.get("x-raw-full-output-capped"), String(capped), `${label} ${callId}`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, Buffer.byteLength(body), `${label} ${callId}`);
      assert.ok(bytes.equals(Buffer.from(body)), `${label} ${callId} bytes`);
    }
    const unauthorized = await get(fixture.producers, "bash-1", false);
    assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
    assert.deepEqual(spillListing(), before, `${label}: the route wrote nothing`);
  });
  const paths: string[] = [];
  try {
    await check("first server");
    await check("reopened server and store");
    await compactBoth(fixture);
    await check("after compaction");
    await serve(fixture, async (get) => {
      const body = async (response: Response) => ({ status: response.status, body: await response.json() as { error: { code: string } } });
      // A known call whose result fit needs no copy, so there is nothing to serve.
      const small = await body(await get(fixture.producers, "rows-small"));
      assert.equal(small.status, 410); assert.equal(small.body.error.code, "full_output_unavailable");
      assert.equal((await body(await get(fixture.producers, "nope"))).status, 404);
      assert.equal((await body(await get("no-such-session", "bash-1"))).status, 404);
      // A deleted copy is gone; the route does not re-create it.
      const store = openSessionStore({ cwd: fixture.root, env: fixture.env });
      let rowsPath: string;
      try {
        const item = store.getSessionHistory({ sessionId: fixture.producers, limit: 100 }).items
          .find((entry) => entry.kind === "tool_result" && (entry.payload.display as { id?: string }).id === "rows-1")!;
        rowsPath = (item.payload.display as { host: { fullOutputPath: string } }).host.fullOutputPath;
        paths.push(rowsPath, (store.getSessionHistory({ sessionId: fixture.producers, limit: 100 }).items
          .find((entry) => entry.kind === "tool_result" && (entry.payload.display as { id?: string }).id === "flood-1")!
          .payload.display as { host: { fullOutputPath: string } }).host.fullOutputPath);
        // Hand-written records: a path outside the spill directories, a link out of a spill-shaped directory, a relative path.
        const fake = mkdtempSync(join(tmpdir(), "raw-output-"));
        paths.push(fake);
        symlinkSync(join(fixture.root, "secret.txt"), join(fake, "escape.log"));
        writeFileSync(join(fixture.root, "secret.txt"), "secret");
        // A FIFO inside a spill directory: opening it must not block waiting for a writer.
        execFileSync("mkfifo", [join(fake, "pipe.log")]);
        store.appendHistory({ sessionId: fixture.clearing, kind: "context_clearing", payload: { results: [
          { callId: "forged-outside", tool: "probe", bytes: 6, path: join(fixture.root, "secret.txt") },
          { callId: "forged-link", tool: "probe", bytes: 6, path: join(fake, "escape.log") },
          { callId: "forged-relative", tool: "probe", bytes: 6, path: "raw-output-x/escape.log" },
          { callId: "forged-dotdot", tool: "probe", bytes: 6, path: join(fake, "..", "..", "etc", "hosts") },
          { callId: "forged-fifo", tool: "probe", bytes: 6, path: join(fake, "pipe.log") },
        ] } });
      } finally { store.close(); }
      rmSync(rowsPath, { force: true });
      const gone = await body(await get(fixture.producers, "rows-1"));
      assert.equal(gone.status, 410); assert.equal(gone.body.error.code, "full_output_unavailable");
      assert.throws(() => statSync(rowsPath), /ENOENT/);
      for (const callId of ["forged-outside", "forged-link", "forged-relative", "forged-dotdot"]) {
        const refused = await body(await get(fixture.clearing, callId));
        assert.equal(refused.status, 403, callId); assert.equal(refused.body.error.code, "full_output_refused", callId);
      }
      const fifo = await body(await get(fixture.clearing, "forged-fifo"));
      assert.equal(fifo.status, 410); assert.equal(fifo.body.error.code, "full_output_unavailable");
      // The older clearing still resolves after a newer record that does not contain the call.
      const older = await get(fixture.clearing, fixture.cleared.a);
      assert.equal(older.status, 200); assert.equal(await older.text(), probeText(fixture.cleared.a));
    });
  } finally {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
