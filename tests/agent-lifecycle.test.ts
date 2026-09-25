import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const fake = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter => ({
  modelConfig: { agentName: "fake", provider: "ollama", method: "openai-chat-completions", model: "fixture" }, generate,
});
const options = (cwd: string, provider: ProviderAdapter) => ({ cwd, provider, registry: createTestToolRegistry(), system: "tiny", maxSteps: 5, maxOutputBytes: 8192, requestTimeoutMs: 2000, autoApprove: true });

test("abort in inference preserves user history and settles one terminal event", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-abort-model-"));
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const agent = createAgent(options(cwd, fake((request) => new Promise((_resolve, reject) => {
    entered();
    request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }))));
  const events: string[] = [];
  const running = agent.run("task", (event) => events.push(event.type));
  await ready;
  agent.abort();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(agent.transcript.map((message) => message.role), ["user"]);
  assert.equal(events.filter((type) => type === "run_end").length, 1);
});

test("late inference completion cannot restart a cancelled run or mutate history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-late-provider-"));
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let complete!: (turn: ProviderTurn) => void;
  const pending = new Promise<ProviderTurn>((resolve) => { complete = resolve; });
  const agent = createAgent(options(cwd, fake(async () => { entered(); return pending; })));
  const running = agent.run("task");
  await ready;
  agent.abort();
  const result = await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort did not settle")), 150))]);
  assert.equal(result.status, "cancelled");
  complete({ text: "late", toolCalls: [], finishReason: "stop" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(agent.transcript.map((message) => message.role), ["user"]);
  assert.equal(agent.state, "idle");
});

test("abort during unresolved approval records matching cancellation without executing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-abort-approval-"));
  let resolveApproval!: (allowed: boolean) => void;
  const approval = new Promise<boolean>((resolve) => { resolveApproval = resolve; });
  let approvalEntered!: () => void;
  const ready = new Promise<void>((resolve) => { approvalEntered = resolve; });
  const provider = fake(async () => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "marker", content: "bad" }] } }] }));
  const agent = createAgent({ ...options(cwd, provider), autoApprove: false, approve: () => { approvalEntered(); return approval; } });
  const starts: string[] = [];
  const running = agent.run("task", (event) => { if (event.type === "tool_start") starts.push(event.name); });
  await ready;
  agent.abort();
  const result = await running;
  resolveApproval(true);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(starts, []);
  assert.equal(agent.transcript.at(-1)?.role, "tool");
  await assert.rejects(readFile(join(cwd, "marker")));
});

test("noninteractive approval stops the first attempted tool with no side effect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-approval-needed-"));
  const provider = fake(async () => ({ text: "", finishReason: "tool_calls", toolCalls: [
    { id: "a", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "first", content: "bad" }] } },
    { id: "b", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "second", content: "bad" }] } },
  ] }));
  const agent = createAgent({ ...options(cwd, provider), autoApprove: false });
  const result = await agent.run("task");
  assert.equal(result.status, "error");
  assert.equal(result.code, "approval_required");
  assert.deepEqual(agent.transcript.filter((message) => message.role === "tool").map((message) => message.result.code), ["approval_required", "cancelled"]);
  await assert.rejects(readFile(join(cwd, "first")));
  await assert.rejects(readFile(join(cwd, "second")));
});

test("abort during first active tool records real and cancelled results, then resumes valid history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-abort-tools-"));
  let requests = 0;
  let sawValidRecovery = false;
  const provider = fake(async (request) => {
    requests++;
    if (requests === 1) return { text: "", finishReason: "tool_calls", toolCalls: [
      { id: "done", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "done", content: "real" }] } },
      { id: "sleep", name: "bash", arguments: { commands: [{ command: "sleep 5" }] } },
      { id: "pending", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "pending", content: "bad" }] } },
    ] };
    const calls = request.messages.filter((message) => message.role === "assistant").flatMap((message) => message.toolCalls.map((call) => call.id));
    const results = request.messages.filter((message) => message.role === "tool").map((message) => message.callId);
    sawValidRecovery = calls.length === 3 && results.join(",") === calls.join(",");
    return { text: "resumed", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent(options(cwd, provider));
  const events: string[] = [];
  const running = agent.run("task", (event) => { events.push(event.type); if (event.type === "tool_start" && event.name === "bash") setTimeout(() => agent.abort(), 30); });
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(await readFile(join(cwd, "done"), "utf8"), "real");
  await assert.rejects(readFile(join(cwd, "pending")));
  const toolResults = agent.transcript.filter((message) => message.role === "tool");
  assert.deepEqual(toolResults.map((message) => message.callId), ["done", "sleep", "pending"]);
  assert.equal(toolResults[1]?.result.content[0]?.type === "json"
    ? (toolResults[1].result.content[0].value as { results: Array<{ status: string }> }).results[0]?.status : "", "aborted");
  assert.equal(toolResults[2]?.result.code, "cancelled");
  assert.equal(events.filter((type) => type === "run_end").length, 1);
  assert.equal((await agent.run("recover")).status, "completed");
  assert.equal(sawValidRecovery, true);
});

test("validation, unknown tool, denial and nonzero shell exit flow back without false starts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-errors-"));
  let requests = 0;
  const provider = fake(async () => ++requests === 1 ? { text: "", finishReason: "tool_calls", toolCalls: [
    { id: "bad", name: "write_file", arguments: {}, argumentError: "invalid JSON", rawArguments: "{oops" },
    { id: "missing", name: "unknown", arguments: {} },
    { id: "denied", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: "denied", content: "bad" }] } },
    { id: "nonzero", name: "bash", arguments: { commands: [{ command: "exit 7" }] } },
  ] } : { text: "handled", toolCalls: [], finishReason: "stop" });
  const agent = createAgent({ ...options(cwd, provider), autoApprove: false, approve: (name: string) => name !== "write_file" });
  const starts: string[] = [];
  const result = await agent.run("errors", (event) => { if (event.type === "tool_start") starts.push(event.name); });
  assert.equal(result.status, "completed");
  assert.deepEqual(starts, ["bash"]);
  const results = agent.transcript.filter((message) => message.role === "tool");
  assert.deepEqual(results.map((message) => message.result.code), ["invalid_arguments", "tool_not_exposed", "approval_denied", undefined]);
  assert.equal(results[3]?.result.content[0]?.type === "json"
    ? (results[3].result.content[0].value as { results: Array<{ exit_code: number }> }).results[0]?.exit_code : undefined, 7);
  await assert.rejects(readFile(join(cwd, "denied")));
});

test("busy same session, isolated concurrent session and closed state", async () => {
  const [a, b] = await Promise.all([mkdtemp(join(tmpdir(), "raw-session-a-")), mkdtemp(join(tmpdir(), "raw-session-b-"))]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const first = createAgent(options(a, fake(async () => { entered(); await gate; return { text: "a", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 1 } }; })));
  const second = createAgent(options(b, fake(async () => ({ text: "b", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 2 } }))));
  const running = first.run("one");
  await ready;
  await assert.rejects(first.run("two"), /busy/);
  assert.equal((await second.run("elsewhere")).text, "b");
  release();
  assert.equal((await running).text, "a");
  assert.deepEqual(first.transcript.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(second.transcript.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(first.usageRecords, [{ prompt_tokens: 1 }]);
  assert.deepEqual(second.usageRecords, [{ prompt_tokens: 2 }]);
  await first.close();
  await assert.rejects(first.run("closed"), /closed/);
});

test("close aborts active inference and rejects future runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-close-"));
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const provider = fake((request) => new Promise((_resolve, reject) => {
    entered();
    request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const agent = createAgent(options(cwd, provider));
  const running = agent.run("task");
  await ready;
  await agent.close();
  assert.equal((await running).status, "cancelled");
  assert.equal(agent.state, "closed");
  await assert.rejects(agent.run("again"), /closed/);
});

test("throwing observer cannot leave orphan calls or duplicate terminal events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-observer-"));
  let requests = 0;
  const provider = fake(async (request) => {
    requests++;
    if (requests === 1) return { text: "", finishReason: "tool_calls", toolCalls: [
      { id: "a", name: "read_file", arguments: { files: [{ path: "missing" }] } },
      { id: "b", name: "read_file", arguments: { files: [{ path: "missing" }] } },
    ] };
    const ids = request.messages.filter((message) => message.role === "tool").map((message) => message.callId);
    assert.deepEqual(ids, ["a", "b"]);
    return { text: "recovered", toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent(options(cwd, provider));
  let ends = 0;
  const first = await agent.run("task", (event) => {
    if (event.type === "tool_result") throw new Error("renderer failed");
    if (event.type === "run_end") ends++;
  });
  assert.equal(first.status, "error");
  assert.equal(ends, 1);
  assert.deepEqual(agent.transcript.filter((message) => message.role === "tool").map((message) => message.callId), ["a", "b"]);
  assert.equal((await agent.run("resume")).text, "recovered");

  const simple = createAgent(options(cwd, fake(async () => ({ text: "ok", toolCalls: [], finishReason: "stop" }))));
  let terminalAttempts = 0;
  const result = await simple.run("task", (event) => { if (event.type === "run_end") { terminalAttempts++; throw new Error("sink broke"); } });
  assert.equal(result.status, "completed");
  assert.equal(terminalAttempts, 1);
});

test("event mutations cannot change authorized arguments, tool history or usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-event-mutation-"));
  const registry = createTestToolRegistry();
  let executed: unknown;
  registry.register({ name: "record", description: "Record", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, handler: async (args) => {
    executed = args.value;
    return { isError: false, content: [{ type: "text", text: "real" }] };
  } });
  let approved: unknown;
  let requests = 0;
  const provider = fake(async () => ++requests === 1
    ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "record", arguments: { value: "approved" } }], usage: { input: 1 } }
    : { text: "done", toolCalls: [], finishReason: "stop" });
  const agent = createAgent({ ...options(cwd, provider), registry, autoApprove: false, approve: (_name, args) => { approved = args.value; return true; } });
  const result = await agent.run("task", (event) => {
    if (event.type === "tool_start") event.arguments.value = "changed";
    if (event.type === "tool_result" && event.result.content[0]?.type === "text") event.result.content[0].text = "corrupted";
    if (event.type === "usage") (event.raw as { input: number }).input = 999;
  });
  assert.equal(result.status, "completed");
  assert.equal(approved, "approved");
  assert.equal(executed, "approved");
  const tool = agent.transcript.find((message) => message.role === "tool");
  assert.equal(tool?.result.content[0]?.type === "text" ? tool.result.content[0].text : "", "real");
  assert.deepEqual(agent.usageRecords, [{ input: 1 }]);
});

test("abort from usage observer prevents final assistant commit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-usage-abort-"));
  const agent = createAgent(options(cwd, fake(async () => ({ text: "answer", toolCalls: [], finishReason: "stop", usage: { input: 1 } }))));
  let accepted = false;
  const result = await agent.run("task", (event) => { if (event.type === "usage") accepted = agent.abort(); });
  assert.equal(accepted, true);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(agent.transcript.map((message) => message.role), ["user"]);
});
