import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAcpClient } from "../src/acp/client.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

test("T-07e: parent client helper can be constructed with a stdio child launch contract", async () => {
  const parent = await createAcpClient({ command: process.execPath, args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio",
    "--config", testConfig("ollama"), "-y"] });
  try { assert.ok(parent.connection); }
  finally { await parent.close(); }
});

test("T-07 review: parent client reports missing executable and cwd as rejected creation", async () => {
  await assert.rejects(createAcpClient({ command: "raw-cli-command-that-does-not-exist", args: [] }), /ENOENT|spawn/);
  await assert.rejects(createAcpClient({ command: process.execPath, args: ["--version"], cwd: "/raw-cli-nonexistent-cwd" }), /ENOENT|spawn/);
});

test("T-07 review: closing only parent connection aborts active reverse callback", async () => {
  const responses: Array<{ frames: string[] }> = [];
  const fixture = await startMockProvider(responses);
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("openai", "fixture", fixture.url), "-y"],
    env: { ...process.env, OPENAI_API_KEY: "key" } });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  try {
    const sessionId = await parent.newSession(process.cwd());
    const registered = await parent.registerTool(sessionId, "slow", "slow callback", { type: "object" }, (_call, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      entered();
      return new Promise<never>(() => {});
    });
    responses.push({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "slow", type: "function",
      function: { name: registered.alias, arguments: "{}" } }] }, "tool_calls"), openAiDone] });
    const pending = parent.prompt(sessionId, "call slow");
    pending.catch(() => {});
    await ready;
    parent.connection.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
  } finally { await parent.close(); await fixture.close(); }
});

test("T-07 review: parent close waits for daemon and owned MCP child to exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-parent-mcp-close-"));
  const pidFile = join(root, "mcp.pid");
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("ollama"), "-y"] });
  const daemonPid = parent.pid;
  let mcpPid = 0;
  try {
    await parent.newSession(process.cwd(), [{ name: "owned", command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"], env: [{ name: "MCP_PID_FILE", value: pidFile }] }]);
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await access(pidFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    mcpPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(mcpPid > 0);
  } finally { await parent.close(); }
  assert.ok(daemonPid);
  assert.throws(() => process.kill(daemonPid, 0));
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(mcpPid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("MCP child survived parent close");
});

test("T-07a/e: parent library spawns daemon, runs tools without permission, streams updates and reaps child PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-parent-"));
  await writeFile(join(root, "sentinel.txt"), "parent-sentinel");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"sentinel.txt"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "read completed" }, "stop"), openAiDone] },
  ]);
  let permissions = 0;
  const updates: string[] = [];
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("openai", "fixture", fixture.url)],
    env: { ...process.env, OPENAI_API_KEY: "key" },
    onPermission: () => { permissions++; return { outcome: { outcome: "selected", optionId: "allow" } }; },
    onUpdate: (update) => { updates.push(update.update.sessionUpdate); },
  });
  const pid = parent.pid;
  try {
    const sessionId = await parent.newSession(root);
    assert.equal((await parent.prompt(sessionId, "read file")).stopReason, "end_turn");
    assert.equal(permissions, 0);
    assert.ok(updates.includes("tool_call") && updates.includes("tool_call_update") && updates.includes("agent_message_chunk"));
    assert.match(JSON.stringify((fixture.requests[1]?.body as { messages: unknown[] }).messages), /parent-sentinel/);
  } finally { await parent.close(); await fixture.close(); }
  assert.ok(pid);
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("parent client child PID did not exit");
});

test("T-07c/e: parent client registers executable reverse tool and its result reaches real SDK inference", async () => {
  const responses: Array<{ frames: string[] }> = [];
  const fixture = await startMockProvider(responses);
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", testConfig("openai", "fixture", fixture.url), "-y"],
    env: { ...process.env, OPENAI_API_KEY: "key" } });
  try {
    const sessionId = await parent.newSession(process.cwd());
    let invoked = 0;
    const registered = await parent.registerTool(sessionId, "parent_echo", "Echo through parent", {
      type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
    }, async (call) => { invoked++; return { isError: false, content: [{ type: "text", text: `parent:${String(call.arguments.value)}` }] }; });
    responses.push({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "reverse", type: "function",
      function: { name: registered.alias, arguments: '{"value":"sentinel"}' } }] }, "tool_calls"), openAiDone] });
    responses.push({ frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] });
    assert.equal((await parent.prompt(sessionId, "call parent")).stopReason, "end_turn");
    assert.equal(invoked, 1);
    assert.match(JSON.stringify((fixture.requests[1]?.body as { messages: unknown[] }).messages), /parent:sentinel/);
  } finally { await parent.close(); await fixture.close(); }
});
