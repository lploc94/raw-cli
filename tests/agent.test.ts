import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const fake = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter => ({
  profile: { name: "fake", provider: "ollama", method: "openai-chat-completions", model: "fixture" }, generate,
});
const options = (cwd: string, provider: ProviderAdapter, maxSteps = 25) => ({
  cwd, provider, registry: createTestToolRegistry(), system: "tiny", maxSteps, maxOutputBytes: 8192,
  requestTimeoutMs: 2000, autoApprove: true,
});

test("real SDK fixture executes write/read/bash and carries exact history into the next user turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-agent-"));
  const first = [openAiFrame({ tool_calls: [
    { index: 0, id: "write", type: "function", function: { name: "write_file", arguments: '{"operations":[{"mode":"overwrite","path":"item","content":"hello"}]}' } },
    { index: 1, id: "read", type: "function", function: { name: "read_file", arguments: '{"files":[{"path":"item"}]}' } },
    { index: 2, id: "shell", type: "function", function: { name: "bash", arguments: '{"commands":[{"command":"printf x >> count; cat item"}]}' } },
  ] }, "tool_calls"), openAiDone];
  const fixture = await startMockProvider([{ frames: first }, { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] }, { frames: [openAiFrame({ content: "again" }, "stop"), openAiDone] }]);
  try {
    const provider = createProvider({ name: "fixture", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "test" });
    const agent = createAgent(options(cwd, provider));
    const events: string[] = [];
    const firstRun = await agent.run("do it", (event) => events.push(event.type));
    assert.equal(firstRun.status, "completed");
    assert.equal(firstRun.steps, 2);
    assert.equal(firstRun.text, "done");
    assert.equal(await readFile(join(cwd, "item"), "utf8"), "hello");
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    assert.deepEqual(events.filter((type) => type === "tool_start").length, 3);
    assert.equal(events.filter((type) => type === "run_end").length, 1);
    const replay = JSON.stringify(fixture.requests[1]?.body);
    assert.match(replay, /"tool_call_id":"write"/);
    assert.match(replay, /"tool_call_id":"read"/);
    assert.match(replay, /"tool_call_id":"shell"/);
    assert.match(replay, /hello/);
    const second = await agent.run("continue");
    assert.equal(second.text, "again");
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    assert.match(JSON.stringify(fixture.requests[2]?.body), /continue/);
    assert.match(JSON.stringify(fixture.requests[2]?.body), /done/);
    assert.equal(agent.transcript.filter((message) => message.role === "tool").length, 3);
  } finally { await fixture.close(); }
});

test("step budget never dispatches a tool whose result cannot be consumed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-steps-"));
  const marker = join(cwd, "sentinel");
  let calls = 0;
  const provider = fake(async () => { calls++; return { text: "", toolCalls: [{ id: `c${calls}`, name: "write_file", arguments: { operations: [{ mode: "overwrite", path: marker, content: "bad" }] } }], finishReason: "tool_calls" }; });
  const one = createAgent(options(cwd, provider, 1));
  const result = await one.run("task");
  assert.equal(result.status, "max_steps");
  assert.equal(result.steps, 1);
  assert.equal(calls, 1);
  assert.deepEqual(one.transcript.map((message) => message.role), ["user"]);
  await assert.rejects(readFile(marker));

  let executed = 0;
  const registry = createTestToolRegistry();
  registry.register({ name: "count", description: "Count", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: async () => { executed++; return { isError: false, content: [{ type: "text", text: "ok" }] }; } });
  let requests = 0;
  const twentyFive = createAgent({ ...options(cwd, fake(async () => {
    requests++;
    return requests < 25
      ? { text: "", toolCalls: [{ id: `id${requests}`, name: "count", arguments: {} }], finishReason: "tool_calls" }
      : { text: "finished", toolCalls: [], finishReason: "stop" };
  }), 25), registry });
  const finished = await twentyFive.run("count");
  assert.equal(finished.status, "completed");
  assert.equal(requests, 25);
  assert.equal(executed, 24);

  let boundaryRequests = 0;
  const boundary = createAgent({ ...options(cwd, fake(async () => {
    boundaryRequests++;
    return boundaryRequests < 25
      ? { text: "", toolCalls: [{ id: `prior${boundaryRequests}`, name: "count", arguments: {} }], finishReason: "tool_calls" }
      : { text: "", toolCalls: [{ id: "last", name: "write_file", arguments: { operations: [{ mode: "overwrite", path: marker, content: "bad" }] } }], finishReason: "tool_calls" };
  }), 25), registry });
  const last = await boundary.run("never write on final step");
  assert.equal(last.status, "max_steps");
  assert.equal(boundaryRequests, 25);
  assert.equal(boundary.transcript.filter((message) => message.role === "assistant").length, 24);
  await assert.rejects(readFile(marker));
});
