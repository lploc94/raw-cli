import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { connectMcpServers, loadMcpConfig } from "../src/tools/mcp-client.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { startMcpHttp } from "./fixtures/mcp-http.js";

const stdio = (label: string, count = 2) => ({ command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"],
  env: { MCP_LABEL: label, MCP_COUNT: String(count) }, tools: ["selected"] });

test("T-07 review: selected MCP alias collision with pre-registered tool fails startup", async () => {
  const alias = `mcp_fixture_selected_${createHash("sha256").update("fixture\0selected").digest("hex").slice(0, 12)}`;
  const registry = createToolRegistry();
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
        const agent = createAgent({ provider: createProvider({ name: "model", provider: "openai", model: "fixture", baseUrl: fixture.url, apiKey: "key" }),
            registry: connection.registry, cwd: process.cwd(), autoApprove: true });
        try {
          assert.equal((await agent.run("call the selected tool")).text, "done");
          const second = fixture.requests[1]?.body as { messages: Array<{ role: string; content: string }> };
          assert.match(JSON.stringify(second.messages), new RegExp(`${name}:selected:ping`));
          assert.deepEqual((fixture.requests[0]?.body as { tools: Array<{ function: { name: string } }> }).tools.map((tool) => tool.function.name),
            ["read_file", "write_file", "bash", alias]);
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
    assert.deepEqual(names.slice(0, 3), ["read_file", "write_file", "bash"]);
    assert.deepEqual(names.slice(3), [...names.slice(3)].sort());
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
    assert.deepEqual(connection.registry.definitions().slice(3).map((item) => item.name), connection.exposed.map((item) => item.alias));
  } finally { await connection.close(); }
});

test("T-06b/c: omitted selection exposes none, config overlay is whole-entry, and failed startup closes owned clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-mcp-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, "raw"), { recursive: true });
  await mkdir(project);
  await writeFile(join(home, "raw", "mcp.json"), JSON.stringify({ mcpServers: { shared: stdio("user"), onlyUser: { ...stdio("u"), tools: [] } } }));
  await writeFile(join(project, "raw-mcp.json"), JSON.stringify({ mcpServers: { shared: { ...stdio("project"), tools: [] } } }));
  const config = loadMcpConfig({ cwd: project, env: { XDG_CONFIG_HOME: home } });
  assert.deepEqual(config.shared?.tools, []);
  if (!config.shared || !("command" in config.shared)) throw new Error("expected stdio config");
  assert.equal(config.shared?.env?.MCP_LABEL, "project");
  const connection = await connectMcpServers({ servers: config, cwd: process.cwd(), timeoutMs: 3000 });
  try { assert.equal(connection.discovered.length, 4); assert.equal(connection.exposed.length, 0); assert.equal(connection.registry.definitions().length, 3); }
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
  const provider = { profile: { name: "fake", provider: "ollama" as const, model: "fixture" },
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
