import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent } from "../src/agent.js";
import { InteractionService } from "../src/interactions/service.js";
import { openSessionStore } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";

test("persisted agents require a correctly bound interaction host before claiming ownership; a separate same-store connection works", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-interaction-binding-"));
  const storeOptions = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  const store = openSessionStore(storeOptions); const same = openSessionStore(storeOptions);
  const wrong = openSessionStore({ env: { XDG_STATE_HOME: join(root, "wrong") } });
  const session = store.createSession({ cwd: root, title: "binding" });
  const memory = new InteractionService({ available: true });
  const mismatch = new InteractionService({ store: wrong, available: true });
  let callbacks = 0;
  const bound = new InteractionService({ store: same, adapter: async request => {
    callbacks++;
    assert.equal(store.getInteraction(session.id, request.identity.requestId)?.state, "pending");
    return { requestId: request.identity.requestId, expectedRevision: request.revision, idempotencyKey: "once", response: "submit", answers: { q: "durable" } };
  } });
  const registry = new ToolRegistry();
  for (const tool of await loadBundledTools(["ask_user"])) registry.register(tool);
  let calls = 0;
  const provider = { modelConfig: { agentName: "fixture", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" }, generate: async () => ++calls === 1
    ? { text: "", finishReason: "tool_calls" as const, toolCalls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ id: "q", label: "Q", kind: "text" }] } }] }
    : { text: "done", finishReason: "stop" as const, toolCalls: [] } };
  const options = { provider, registry, cwd: root, persistence: { store, sessionId: session.id, surface: "cli" as const } };
  let agent: ReturnType<typeof createAgent> | undefined;
  try {
    assert.throws(() => createAgent({ ...options, interactions: memory }), /same.*session store|bound.*store/);
    assert.throws(() => createAgent({ ...options, interactions: mismatch }), /same.*session store|bound.*store/);
    assert.equal(store.sessionIsBusy(session.id), false); assert.equal(calls, 0); assert.equal(callbacks, 0);
    agent = createAgent({ ...options, interactions: bound });
    assert.equal((await agent.run("ask")).status, "completed");
    assert.equal(callbacks, 1);
    await agent.close(); agent = undefined;
    const history = store.getSessionHistory({ sessionId: session.id }).items;
    assert.equal(history.filter(row => row.kind === "interaction_request").length, 1);
    assert.equal(history.filter(row => row.kind === "interaction_response").length, 1);
    const memoryAgent = createAgent({ provider, interactions: memory }); await memoryAgent.close();
  } finally { await agent?.close(); memory.close(); mismatch.close(); bound.close(); wrong.close(); same.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
