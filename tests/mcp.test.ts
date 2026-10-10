import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { connectMcpServers } from "../src/tools/mcp-client.js";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { startMcpHttp } from "./fixtures/mcp-http.js";

const stdio = (label: string, count = 2) => ({ command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"],
  env: { MCP_LABEL: label, MCP_COUNT: String(count) }, tools: ["selected"] });

test("agent deny removes selected MCP tool from exposed set and direct dispatch", async () => {
  const registry = createTestToolRegistry([{ match: "mcp/fixture/selected", effect: "deny" }]);
  const connection = await connectMcpServers({ servers: { fixture: stdio("fixture") }, registry,
    cwd: process.cwd(), timeoutMs: 3000 });
  try {
    assert.equal(connection.exposed.length, 0);
    assert.equal(connection.catalog.length, 2);
    assert.deepEqual(registry.definitions().map((item) => item.name), ["read_file", "write_file", "bash"]);
    const alias = connection.catalog.find((item) => item.originalName === "selected")?.alias;
    assert.ok(alias);
    const denied = await registry.dispatch(alias, { value: "attempt" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.equal(denied.code, "tool_denied");
  } finally { await connection.close(); }
});

test("T-07 review: selected MCP alias collision with pre-registered tool fails startup", async () => {
  const alias = `mcp_fixture_selected_${createHash("sha256").update("fixture\0selected").digest("hex").slice(0, 12)}`;
  const registry = createTestToolRegistry();
  registry.register({ name: alias, description: "pre-existing", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [{ type: "text", text: "wrong-handler" }] }) });
  await assert.rejects(connectMcpServers({ servers: { fixture: stdio("fixture") }, registry,
    cwd: process.cwd(), timeoutMs: 3000 }), /duplicate MCP alias/);
});

test("T-06a: all official SDK transports paginate and selected page-two tools reach provider follow-up", async () => {
  const http = await Promise.all([startMcpHttp("sse", "sse"), startMcpHttp("streamable-http", "http")]);
  const specs = [
    { name: "stdio", server: stdio("stdio") },
    { name: "sse", server: { url: http[0]!.url, transport: "sse" as const, tools: ["selected"] } },
    { name: "http", server: { url: http[1]!.url, transport: "streamable-http" as const, tools: ["selected"] } },
  ];
  try {
    for (const { name, server } of specs) {
      const connection = await connectMcpServers({ servers: { [name]: server }, cwd: process.cwd(), timeoutMs: 3000 });
      try {
        assert.equal(connection.discovered.length, 2);
        assert.equal(connection.exposed.length, 1);
        const alias = connection.exposed[0]!.alias;
        const fixture = await startMockProvider([
          { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: alias, arguments: '{"value":"ping"}' } }] }, "tool_calls"), openAiDone] },
          { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
        ]);
        const agent = createAgent({ provider: createProvider({ agentName: "model", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "key" }),
            registry: connection.registry, cwd: process.cwd(), autoApprove: true });
        try {
          assert.equal((await agent.run("call the selected tool")).text, "done");
          const second = fixture.requests[1]?.body as { messages: Array<{ role: string; content: string }> };
          assert.match(JSON.stringify(second.messages), new RegExp(`${name}:selected:ping`));
          assert.deepEqual((fixture.requests[0]?.body as { tools: Array<{ function: { name: string } }> }).tools.map((tool) => tool.function.name),
            [alias]);
        } finally { await agent.close(); await fixture.close(); }
      } finally { await connection.close(); }
    }
  } finally { await Promise.all(http.map((item) => item.close())); }
});

test("T-06b: 100 discovered tools expose only selected names, route same names to distinct servers and enforce schema", async () => {
  const connection = await connectMcpServers({ servers: { zed: stdio("Z", 100), alpha: stdio("A", 2) }, cwd: process.cwd(), timeoutMs: 3000 });
  try {
    assert.equal(connection.discovered.length, 102);
    assert.equal(connection.exposed.length, 2);
    const names = connection.registry.definitions().map((item) => item.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(new Set(names).size, names.length);
    const aliases = Object.fromEntries(connection.exposed.map((item) => [item.server, item.alias]));
    for (const [server, sentinel] of [["zed", "Z"], ["alpha", "A"]] as const) {
      const result = await connection.registry.dispatch(aliases[server]!, { value: "v" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
      assert.match(JSON.stringify(result), new RegExp(`${sentinel}:selected:v`));
      const invalid = await connection.registry.dispatch(aliases[server]!, { value: 7 }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
      assert.equal(invalid.code, "invalid_arguments");
    }
    const hidden = await connection.registry.dispatch("hidden_0", { value: "v" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.equal(hidden.code, "tool_not_exposed");
  } finally { await connection.close(); }
  await assert.rejects(connectMcpServers({ servers: { one: { ...stdio("x"), tools: ["missing"] } }, cwd: process.cwd(), timeoutMs: 3000 }), /unknown|missing/);
});

test("MCP tools declaring JSON Schema draft-07 are exposed and validated", async () => {
  const fixture = stdio("draft7");
  const connection = await connectMcpServers({ servers: { draft7: { ...fixture, env: { ...fixture.env, MCP_MODE: "draft7-schema" } } },
    cwd: process.cwd(), timeoutMs: 3000 });
  try {
    assert.equal(connection.exposed.length, 1);
    const alias = connection.exposed[0]!.alias;
    const context = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true };
    assert.match(JSON.stringify(await connection.registry.dispatch(alias, { value: "ok" }, context)), /draft7:selected:ok/);
    assert.equal((await connection.registry.dispatch(alias, { value: 7 }, context)).code, "invalid_arguments");
  } finally { await connection.close(); }
});

test("MCP tools declaring Rust-style numeric formats (uint32/uint8) are exposed and validated", async () => {
  const fixture = stdio("numeric");
  const connection = await connectMcpServers({ servers: { numeric: { ...fixture, env: { ...fixture.env, MCP_MODE: "numeric-formats-schema" } } },
    cwd: process.cwd(), timeoutMs: 3000 });
  try {
    assert.equal(connection.exposed.length, 1);
    const alias = connection.exposed[0]!.alias;
    const context = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true };
    assert.match(JSON.stringify(await connection.registry.dispatch(alias, { value: "ok", limit: 5, max_hops: 2 }, context)), /numeric:selected:ok/);
    assert.equal((await connection.registry.dispatch(alias, { value: "ok", limit: "nope" }, context)).code, "invalid_arguments");
  } finally { await connection.close(); }
});

test("T-06b: all-selection, long-prefix collisions and shuffled discovery remain deterministic", async () => {
  const long = "same_prefix_".repeat(8);
  const servers = {
    [`${long}A`]: { ...stdio("A"), env: { MCP_REVERSE: "1" }, tools: "*" as const },
    [`${long}B`]: { ...stdio("B"), tools: ["selected"] },
  };
  const connection = await connectMcpServers({ servers, cwd: process.cwd(), timeoutMs: 3000 });
  try {
    assert.equal(connection.exposed.length, 3);
    assert.equal(new Set(connection.exposed.map((item) => item.alias)).size, 3);
    assert.ok(connection.exposed.every((item) => item.alias.length <= 64));
    assert.deepEqual(connection.registry.definitions().map((item) => item.name).sort(), connection.exposed.map((item) => item.alias));
  } finally { await connection.close(); }
});

test("T-06b/c: unselected config starts nothing, explicit empty selection discovers without exposure, and failed startup closes clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-mcp-config-"));
  const configPath = join(root, "config.json");
  const stdioSpec = (label: string) => ({ transport: "stdio", command: process.execPath,
    args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: { MCP_LABEL: label, MCP_COUNT: "2" } });
  await writeFile(configPath, JSON.stringify({ default_agent: "plain",
    models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { plain: { model: "local", tools: { use: [] } }, selected: { model: "local", tools: { use: ["mcp/shared/selected", "mcp/onlyUser/selected"] } } },
    mcp: { servers: { shared: stdioSpec("project"), onlyUser: stdioSpec("u") } },
  }));
  const plain = await loadConfig({ configPath, env: {}, requireModel: true });
  assert.equal(Object.keys(plain.mcpServers).length, 0);
  const config = await loadConfig({ configPath, env: {}, flags: { agent: "selected" }, requireModel: true });
  assert.deepEqual(config.mcpServers.shared?.tools, ["selected"]);
  if (!config.mcpServers.shared || !("command" in config.mcpServers.shared)) throw new Error("expected stdio config");
  assert.equal(config.mcpServers.shared?.env?.MCP_LABEL, "project");
  const connection = await connectMcpServers({ servers: Object.fromEntries(Object.entries(config.mcpServers).map(([name, spec]) => [name, { ...spec, tools: [] }])), cwd: process.cwd(), timeoutMs: 3000 });
  try { assert.equal(connection.discovered.length, 4); assert.equal(connection.exposed.length, 0); assert.equal(connection.registry.definitions().length, 0); }
  finally { await connection.close(); }
  const pidFile = join(root, "good.pid");
  await assert.rejects(connectMcpServers({ servers: { a_good: { ...stdio("good"), env: { MCP_PID_FILE: pidFile } }, z_bad: { ...stdio("bad"), env: { MCP_MODE: "crash" } } },
    cwd: process.cwd(), timeoutMs: 1000 }));
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("owned stdio MCP server stayed alive after partial startup failure");
});

test("T-06c: abort during a slow MCP call settles linked result and ignores late remote completion", async () => {
  const connection = await connectMcpServers({ servers: { slow: stdio("slow") }, cwd: process.cwd(), timeoutMs: 3000 });
  const alias = connection.exposed[0]!.alias;
  let calls = 0;
  const provider = { modelConfig: { agentName: "fake", provider: "ollama" as const, method: "openai-chat-completions" as const, model: "fixture" },
    async generate() { calls++; return calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: alias, arguments: { value: "slow" } }] }
      : { text: "unexpected", finishReason: "stop", toolCalls: [] }; } };
  const agent = createAgent({ provider, registry: connection.registry, cwd: process.cwd(), autoApprove: true });
  try {
    const result = await agent.run("slow call", (event) => { if (event.type === "tool_start") setTimeout(() => agent.abort(), 20); });
    assert.equal(result.status, "cancelled");
    assert.equal(calls, 1);
    assert.equal(agent.transcript.filter((item) => item.role === "tool").length, 1);
    const before = JSON.stringify(agent.transcript);
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(JSON.stringify(agent.transcript), before);
  } finally { await agent.close(); await connection.close(); }
});

test("a server's own timeoutMs overrides the connection default", async () => {
  // An in-process server connects well within the short timeout even on a loaded machine.
  const http = await startMcpHttp("streamable-http", "timed");
  const connection = await connectMcpServers({ servers: { timed: { url: http.url, transport: "streamable-http", tools: ["selected"], timeoutMs: 800 } },
    cwd: process.cwd(), timeoutMs: 60000 });
  try {
    const timeout = await connection.registry.dispatch(connection.exposed[0]!.alias, { value: "timeout" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.equal(timeout.code, "mcp_call_error");
    assert.match(JSON.stringify(timeout), /timed out/);
  } finally { await connection.close(); await http.close(); }
});

test("a tool call that keeps reporting progress outlives the request timeout", async () => {
  const http = await startMcpHttp("streamable-http", "busy");
  const connection = await connectMcpServers({ servers: { busy: { url: http.url, transport: "streamable-http", tools: ["selected"] } }, cwd: process.cwd(), timeoutMs: 1000 });
  try {
    const result = await connection.registry.dispatch(connection.exposed[0]!.alias, { value: "progress" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /busy:selected:progress/);
  } finally { await connection.close(); await http.close(); }
});

test("T-06c: SDK tool request deadline returns an explicit error and leaves connection usable", async () => {
  const connection = await connectMcpServers({ servers: { timed: stdio("timed") }, cwd: process.cwd(), timeoutMs: 1000 });
  try {
    const alias = connection.exposed[0]!.alias;
    const context = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true };
    const timeout = await connection.registry.dispatch(alias, { value: "timeout" }, context);
    assert.equal(timeout.code, "mcp_call_error");
    assert.match(JSON.stringify(timeout), /timed out|timeout/i);
    const after = await connection.registry.dispatch(alias, { value: "ok" }, context);
    assert.match(JSON.stringify(after), /timed:selected:ok/);
  } finally { await connection.close(); }
});

test("T-06b: asynchronous JSON Schema is rejected before an invalid argument can execute", async () => {
  await assert.rejects(connectMcpServers({ servers: { asyncTool: { ...stdio("async"), env: { MCP_MODE: "async-schema" } } },
    cwd: process.cwd(), timeoutMs: 3000 }), /async|unsupported/i);
});

test("T-06d: both HTTP transports reject oversized discovery and invocation messages", async () => {
  for (const transport of ["sse", "streamable-http"] as const) {
    const oversizedCatalog = await startMcpHttp(transport, "large", "large-discovery");
    try {
      await assert.rejects(connectMcpServers({ servers: { large: { url: oversizedCatalog.url, transport, tools: ["selected"] } },
        timeoutMs: 3000 }), /large|size|limit|failed/i);
    } finally { await oversizedCatalog.close(); }
    const oversizedCall = await startMcpHttp(transport, "large", "large-result");
    try {
      const connection = await connectMcpServers({ servers: { large: { url: oversizedCall.url, transport, tools: ["selected"] } }, timeoutMs: 3000 });
      try {
        const result = await connection.registry.dispatch(connection.exposed[0]!.alias, { value: "huge" },
          { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
        assert.equal(result.code, "mcp_call_error");
      } finally { await connection.close(); }
    } finally { await oversizedCall.close(); }
  }
});

test("T-06c: echoed HTTP credentials stay out of startup errors and tool results", async () => {
  const secretHeader = "Bearer test-secret-header";
  const secretQuery = "test-secret-query";
  const startup = await startMcpHttp("streamable-http", "secret", "echo-initialize");
  try {
    await assert.rejects(connectMcpServers({ servers: { secret: { url: `${startup.url}?token=${secretQuery}`,
      transport: "streamable-http", headers: { Authorization: secretHeader }, tools: ["selected"] } }, timeoutMs: 3000 }),
    (error: Error) => !error.message.includes(secretHeader) && !error.message.includes(secretQuery));
  } finally { await startup.close(); }
  const invocation = await startMcpHttp("streamable-http", "secret", "echo-error");
  try {
    const connection = await connectMcpServers({ servers: { secret: { url: `${invocation.url}?token=${secretQuery}`,
      transport: "streamable-http", headers: { Authorization: secretHeader }, tools: ["selected"] } }, timeoutMs: 3000 });
    try {
      const result = await connection.registry.dispatch(connection.exposed[0]!.alias, { value: "hello" },
        { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /test-secret-header|test-secret-query/);
    } finally { await connection.close(); }
  } finally { await invocation.close(); }
});

test("T-06c: dropped HTTP event streams do not trigger hidden reconnect attempts", async () => {
  for (const transport of ["sse", "streamable-http"] as const) {
    const fixture = await startMcpHttp(transport, "disconnect");
    const connection = await connectMcpServers({ servers: { disconnect: { url: fixture.url, transport, tools: [] } }, timeoutMs: 3000 });
    try {
      assert.ok(fixture.getRequests >= 1);
      await fixture.dropStreams();
      const before = fixture.getRequests;
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.equal(fixture.getRequests, before);
    } finally { await connection.close(); await fixture.close(); }
  }
});

test("T-06c: initialize uses configured SDK request timeout rather than its 60-second default", async () => {
  const original = globalThis.setTimeout;
  const scheduled: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof timeout === "number") scheduled.push(timeout);
    return original(handler, timeout, ...args);
  }) as typeof setTimeout;
  try {
    await assert.rejects(connectMcpServers({ servers: { crash: { ...stdio("crash"), env: { MCP_MODE: "crash" } } },
      cwd: process.cwd(), timeoutMs: 120000 }));
    assert.ok(scheduled.includes(120000));
    assert.equal(scheduled.includes(60000), false);
  } finally { globalThis.setTimeout = original; }
});

test("T-06c: SSE disconnect during initialize never reconnects before startup deadline", async () => {
  const original = globalThis.fetch;
  let gets = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") return new Response(null, { status: 202 });
    gets++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("retry: 10\nevent: endpoint\ndata: /messages\n\n"));
      setTimeout(() => controller.close(), 25);
    } }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await assert.rejects(connectMcpServers({ servers: { startup: { url: "https://fixture.invalid/sse", transport: "sse" } }, timeoutMs: 180 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(gets, 1);
  } finally { globalThis.fetch = original; }
});

test("T-06d: CR-only SSE event boundaries permit two individually bounded discovery pages", async () => {
  const original = globalThis.fetch;
  let channel: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (event: string, data: unknown) => channel!.enqueue(new TextEncoder().encode(`event: ${event}\rdata: ${typeof data === "string" ? data : JSON.stringify(data)}\r\r: heartbeat\r`));
  globalThis.fetch = (async (_url, init) => {
    if (init?.method !== "POST") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      channel = controller;
      send("endpoint", "/messages");
    } }), { headers: { "content-type": "text/event-stream" } });
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string } };
    if (body.id !== undefined) {
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [{ name: body.params?.cursor ? "second" : "first", description: "x".repeat(9 * 1024 * 1024), inputSchema: { type: "object" } }],
          ...(body.params?.cursor ? {} : { nextCursor: "page2" }) };
      send("message", { jsonrpc: "2.0", id: body.id, result });
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    const connection = await connectMcpServers({ servers: { events: { url: "https://fixture.invalid/sse", transport: "sse" } }, timeoutMs: 3000 });
    try { assert.deepEqual(connection.discovered.map((item) => item.name), ["first", "second"]); }
    finally { await connection.close(); }
  } finally { globalThis.fetch = original; }
});

test("panels: MCP _meta[raw/panel] reaches the registry as a panel block and config panels become declarations", async () => {
  const registry = createTestToolRegistry();
  const spec = { ...stdio("fixture"), panels: [{ tool: "selected", id: "plan", title: "Plan", icon: "list-checks" as const, open: "never" as const,
    context: "none" as const, acp_plan: false, actions: [] }] };
  const connection = await connectMcpServers({ servers: { fixture: spec }, registry, cwd: process.cwd(), timeoutMs: 3000 });
  try {
    const alias = connection.catalog.find((item) => item.originalName === "selected")!.alias;
    const owner = registry.panelDeclarations(alias)!;
    assert.equal(owner.owner, "mcp/fixture/selected");
    assert.deepEqual(owner.declarations.map((panel) => panel.id), ["plan"]);
    assert.equal(owner.implicit, false);
    const collected: unknown[] = [];
    const result = await registry.dispatch(alias, { value: "panel" }, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true,
      onPanelUpdates: (updates) => collected.push(...updates) });
    assert.deepEqual(result.content, [{ type: "text", text: "panelled" }]);
    assert.equal(collected.length, 1);
    assert.equal((collected[0] as { panel: string }).panel, "plan");
  } finally { await connection.close(); }
  const plain = createTestToolRegistry();
  const second = await connectMcpServers({ servers: { fixture: stdio("fixture") }, registry: plain, cwd: process.cwd(), timeoutMs: 3000 });
  try {
    const alias = second.catalog.find((item) => item.originalName === "selected")!.alias;
    assert.equal(plain.panelDeclarations(alias)?.implicit, true, "no config panels means an implicit declaration");
  } finally { await second.close(); }
});

test("degraded startup skips unavailable servers and selected tools while the rest stay usable", async () => {
  const http = await startMcpHttp("streamable-http", "rejecting", "echo-initialize");
  const warnings: string[] = [];
  const connection = await connectMcpServers({ servers: {
    a_good: { ...stdio("good"), tools: ["selected", "missing"] },
    b_async: { ...stdio("async"), env: { MCP_LABEL: "async", MCP_COUNT: "2", MCP_MODE: "async-schema" } },
    c_http: { url: http.url, transport: "streamable-http", tools: ["selected"] },
    z_crash: { ...stdio("crash"), env: { MCP_LABEL: "crash", MCP_COUNT: "2", MCP_MODE: "crash" } },
  }, cwd: process.cwd(), timeoutMs: 3000, onSkip: (message) => warnings.push(message) });
  try {
    assert.deepEqual(connection.exposed.map((item) => item.server), ["a_good"]);
    assert.deepEqual(warnings.length, 4);
    assert.match(warnings.join("\n"), /unknown MCP tool missing selected from a_good; skipped/);
    assert.match(warnings.join("\n"), /unsupported async MCP tool schema for b_async\/selected; skipped/);
    assert.match(warnings.join("\n"), /MCP server c_http connection failed; skipped its tools/);
    assert.match(warnings.join("\n"), /MCP server z_crash connection failed; skipped its tools/);
    const result = await connection.registry.dispatch(connection.exposed[0]!.alias, { value: "ok" },
      { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true });
    assert.match(JSON.stringify(result), /good:selected:ok/);
  } finally { await connection.close(); await http.close(); }
});

test("createRuntimeTools drops unavailable MCP selections with warnings instead of failing startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-mcp-degrade-"));
  const configPath = join(root, "config.json");
  const stdioSpec = (label: string, mode?: string) => ({ transport: "stdio", command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
    env: { MCP_LABEL: label, MCP_COUNT: "2", ...(mode ? { MCP_MODE: mode } : {}) } });
  await writeFile(configPath, JSON.stringify({ default_agent: "a",
    models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { a: { model: "local", tools: { use: ["builtin/read_file", "mcp/good/missing", "mcp/good/selected", "mcp/down/selected"] } } },
    mcp: { servers: { good: stdioSpec("good"), down: stdioSpec("down", "crash") } },
  }));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: process.cwd() });
  try {
    assert.equal(tools.selectedNames.length, 2);
    assert.equal(tools.selectedNames[0], "read_file");
    assert.equal(tools.selectedNames[1], tools.mcp.exposed[0]!.alias);
    assert.match(tools.warnings.join("\n"), /unknown MCP tool missing selected from good; skipped/);
    assert.match(tools.warnings.join("\n"), /MCP server down connection failed; skipped its tools/);
  } finally { await tools.mcp.close(); }
});

test("an abort during the last skipped server's cleanup still fails startup", async () => {
  const controller = new AbortController();
  await assert.rejects(connectMcpServers({ servers: { z_crash: { ...stdio("crash"), env: { MCP_LABEL: "crash", MCP_COUNT: "2", MCP_MODE: "crash" } } },
    cwd: process.cwd(), timeoutMs: 3000, signal: controller.signal, onSkip: () => controller.abort() }), /aborted/);
});

test("an MCP tool whose schema cannot bind a selected hook condition is skipped, not registered", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-mcp-hook-"));
  const configPath = join(root, "config.json");
  const hook = join(root, "hooks", "guard");
  await mkdir(hook, { recursive: true });
  await writeFile(join(hook, "hook.json"), JSON.stringify({ protocol_version: 2, name: "guard", command: "node", args: ["./run.mjs"],
    events: [{ name: "PreToolUse", match: "mcp/good/selected", when: { source: "arguments", any: "absent", regex: "x" } }] }));
  await writeFile(join(hook, "run.mjs"), "process.stdout.write('{}')\n");
  await writeFile(configPath, JSON.stringify({ default_agent: "a",
    models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { a: { model: "local", hooks: { use: ["agent/guard"] }, tools: { use: ["builtin/read_file", "mcp/good/selected"] } } },
    mcp: { servers: { good: { transport: "stdio", command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "tests/fixtures/mcp-stdio.ts")], env: { MCP_LABEL: "good", MCP_COUNT: "2" } } } },
  }));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: process.cwd() });
  try {
    assert.deepEqual(tools.selectedNames, ["read_file"]);
    assert.deepEqual(tools.mcp.exposed, []);
    assert.equal(tools.registry.nameForIdentity("mcp/good/selected"), undefined);
    assert.equal(tools.warnings.length, 1);
    assert.match(tools.warnings[0]!, /skipped$/);
  } finally { await tools.mcp.close(); }
});
