import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { SelectedHook } from "../src/hooks/contract.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function setup(script: string) {
  const cwd = await mkdtemp(join(tmpdir(), "raw-hooks-life-"));
  const scriptPath = join(cwd, "hook.mjs");
  const log = join(cwd, "events.jsonl");
  await writeFile(scriptPath, script);
  const hook: SelectedHook = { protocol_version: 2, id: "agent/watch", name: "watch", folder: cwd, command: process.execPath,
    args: [scriptPath, log], timeoutMs: 1000, events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
      "PostToolUseFailure", "Stop", "SessionEnd"].map(name => ({ name: name as SelectedHook["events"][number]["name"] })) };
  const registry = new ToolRegistry();
  registry.register({ name: "doit", canonicalName: "agent/doit", description: "fixture",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: String(args.value) }] }) });
  return { cwd, hook, registry, log };
}

test("changing tool exposure binds hook conditions before publishing the new view", async () => {
  const f = await setup("");
  f.hook.events = [{ name: "PreToolUse", match: "acp:*", when: { source: "effects", any: "files[*].path", regex: ".*" } }];
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ({ text: "done", finishReason: "stop", toolCalls: [] }) };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, whitelist: ["doit"], hooks: new HookDispatcher([f.hook]) });
  f.registry.register({ name: "peer", canonicalName: "acp:write", description: "peer", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [] }) });
  assert.throws(() => agent.setToolView(["doit", "peer"]), /source effects is unavailable/);
  assert.deepEqual(agent.toolDefinitions.map(tool => tool.name), ["doit"]);
  const hook = await new HookDispatcher([f.hook]).run("PreToolUse", { cwd: f.cwd, agent_id: "raw", tool: { identity: "acp:write", name: "peer", arguments: {} } });
  assert.equal(hook.blocked, "error");
  await agent.close();
});

test("hook lifecycle receipts include successful empty-output hooks without changing model context", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      appendFileSync(process.argv[2], JSON.stringify(JSON.parse(input)) + "\\n");
    });`);
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const events: Array<{ type: string; outcome?: string }> = [];
  await agent.start("create", event => { if (event.type === "hook_event") events.push(event); });
  const result = await agent.run("do it", event => { if (event.type === "hook_event") events.push(event); });
  await agent.close();
  assert.equal(result.status, "completed");
  assert.deepEqual(events.map(e => e.outcome), ["continued", "continued", "continued", "continued", "continued"]);
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n").map(s => JSON.parse(s).event),
    ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]);
  assert.equal(agent.transcript.some(message => message.role === "tool" && message.result.content[0]?.type === "text"
    && message.result.content[0].text === "ok"), true);
});

test("PreToolUse denial skips approval and handler while preserving model linkage", async () => {
  const f = await setup(`let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
    if (JSON.parse(input).event === "PreToolUse") process.stdout.write(JSON.stringify({ decision:"deny", reason:"blocked" }));
  });`);
  let requests = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++requests === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "bad" } }] }
      : { text: "understood", finishReason: "stop", toolCalls: [] } };
  let approvals = 0;
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]),
    autoApprove: false, approve: () => { approvals++; return true; } });
  const result = await agent.run("do it");
  await agent.close();
  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(agent.transcript.find(message => message.role === "tool")?.result.code, "hook_denied");
});

test("notification failure does not change a completed tool result", async () => {
  const f = await setup(`let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
    if (JSON.parse(input).event === "PostToolUse") process.exitCode = 1;
  });`);
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const receipts: string[] = [];
  const result = await agent.run("do it", event => { if (event.type === "hook_event") receipts.push(`${event.event}:${event.outcome}`); });
  assert.equal(result.status, "completed");
  assert.equal(agent.transcript.find(message => message.role === "tool")?.result.isError, false);
  assert.ok(receipts.includes("PostToolUse:error"));
  await agent.close();
});

test("Stop and SessionEnd run after cancellation without an inherited aborted signal", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      appendFileSync(process.argv[2], JSON.parse(input).event + "\\n");
    });`);
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async request => new Promise((_resolve, reject) => {
      entered(); request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const events: string[] = [];
  const running = agent.run("wait", event => events.push(event.type));
  await ready;
  agent.abort();
  assert.equal((await running).status, "cancelled");
  await agent.close();
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n"),
    ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.equal(events.filter(event => event === "run_end").length, 1);
});

test("observing hooks get their own timeout_ms instead of a fixed two-second budget", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      const event = JSON.parse(input).event;
      setTimeout(() => { appendFileSync(process.argv[2], event + "\\n"); }, event === "PostToolUse" ? 2300 : 0);
    });`);
  f.hook.timeoutMs = 10000;
  f.hook.events = [{ name: "PostToolUse" }];
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const outcomes: string[] = [];
  const result = await agent.run("do it", event => { if (event.type === "hook_event") outcomes.push(event.outcome); });
  await agent.close();
  assert.equal(result.status, "completed");
  assert.deepEqual(outcomes, ["continued"]);
  assert.equal((await readFile(f.log, "utf8")).trim(), "PostToolUse");
});
