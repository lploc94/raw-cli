import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn, ResolvedModelConfig } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { loadToolPlugins } from "../src/tools/plugins/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";

const done: ProviderTurn = { text: "answer", toolCalls: [], finishReason: "stop" };

for (const change of [
  { name: "prompt", before: { system: "old prompt" }, after: { system: "new prompt" } },
  { name: "model", before: { model: "model-one" }, after: { model: "model-two" } },
  { name: "provider", before: { provider: "ollama" }, after: { provider: "openai" } },
  { name: "method", before: { method: "openai-chat-completions" }, after: { method: "openai-responses" } },
  { name: "endpoint", before: { baseUrl: "https://one.example/v1" }, after: { baseUrl: "https://two.example/v1" } },
  { name: "request", before: { request: { kind: "generic" } }, after: { request: { kind: "generic", maxOutputTokens: 100 } } },
  { name: "agent", before: { agentName: "original" }, after: { agentName: "renamed" } },
] as const) {
  test(`changed ${change.name} resumes once and an unchanged second resume is stable`, async () => {
    const root = mkdtempSync(join(tmpdir(), "raw-transition-"));
    const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
    const id = store.createSession({ cwd: root, title: "transition" }).id;
    const captured: Array<{ system: string; messages: ProviderRequest["messages"]; key: string | undefined }> = [];
    const base: ResolvedModelConfig = { agentName: "original", provider: "ollama", method: "openai-chat-completions", model: "fixture" };
    const make = (settings: Record<string, unknown>) => {
      const { system, ...model } = settings;
      const provider: ProviderAdapter = {
        modelConfig: { ...base, ...model } as ResolvedModelConfig,
        generate: async (request) => { captured.push({ system: request.system, messages: structuredClone(request.messages), key: request.cacheKey }); return done; },
      };
      return createAgent({ cwd: root, provider, system: String(system ?? "system"),
        persistence: { store, sessionId: id, surface: "cli" } });
    };
    try {
      const first = make(change.before);
      assert.equal((await first.run("one")).status, "completed");
      const original = first.transcript;
      await first.close();
      const second = make(change.after);
      const changedRevision = second.contextRevision;
      if (change.name === "agent") assert.equal(changedRevision, first.contextRevision);
      else assert.ok(changedRevision > first.contextRevision);
      assert.equal((await second.run("two")).status, "completed");
      assert.match(JSON.stringify(second.transcript.slice(0, original.length)), /one|answer/);
      await second.close();
      const third = make(change.after);
      assert.equal(third.contextRevision, changedRevision);
      assert.equal((await third.run("three")).status, "completed");
      await third.close();
      assert.equal(captured.length, 3);
      if (change.name === "agent") assert.equal(captured[0]!.key, captured[1]!.key);
      else assert.notEqual(captured[0]!.key, captured[1]!.key);
      assert.equal(captured[1]!.key, captured[2]!.key);
      assert.equal(captured[1]!.system, captured[2]!.system);
      assert.deepEqual(captured[2]!.messages.slice(0, captured[1]!.messages.length), captured[1]!.messages);
      const transitions = store.getSessionHistory({ sessionId: id, limit: 100 }).items
        .filter((item) => item.kind === "runtime_transition");
      assert.equal(transitions.length, change.name === "agent" ? 0 : 1);
    } finally { store.close(); }
  });
}

test("a helper-only edit is executed on the next same-process attachment and then stabilizes", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-helper-generation-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "helper" }).id;
  const folder = join(root, "tools", "helper");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "helper", version: "1.0.0",
    name: "helper", description: "Reads helper", input_schema: { type: "object" }, entry: "./index.mjs" }));
  writeFileSync(join(folder, "index.mjs"), `import { value } from "./value.mjs";
    export async function handler() { return { isError: false, content: [{ type: "text", text: value }] }; }`);
  const helperPath = join(folder, "value.mjs");
  writeFileSync(helperPath, 'export const value = "old";\n');
  const seen: Array<{ key: string | undefined; messages: readonly unknown[] }> = [];
  const attach = async () => {
    const plugin = (await loadToolPlugins({ selectedIds: ["agent/helper"], configPath: join(root, "raw.json"), cwd: root }))[0]!;
    const registry = new ToolRegistry(); registry.register(plugin.registration);
    let steps = 0;
    const adapter: ProviderAdapter = { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async (request) => {
        seen.push({ key: request.cacheKey, messages: structuredClone(request.messages) });
        return ++steps % 2 === 1
          ? { text: "", toolCalls: [{ id: `call-${seen.length}`, name: "helper", arguments: {} }], finishReason: "tool_calls" }
          : { text: "done", toolCalls: [], finishReason: "stop" };
      } };
    return createAgent({ cwd: root, provider: adapter, registry, whitelist: ["helper"],
      toolSourceDigest: plugin.sourceDigest, system: "system", persistence: { store, sessionId: id, surface: "cli" } });
  };
  try {
    const first = await attach();
    assert.equal((await first.run("one")).status, "completed");
    assert.match(JSON.stringify(first.transcript), /old/);
    await first.close();
    writeFileSync(helperPath, 'export const value = "new";\n');
    const second = await attach();
    const revision = second.contextRevision;
    assert.equal((await second.run("two")).status, "completed");
    assert.match(JSON.stringify(second.transcript), /new/);
    await second.close();
    const third = await attach();
    assert.equal(third.contextRevision, revision);
    assert.equal((await third.run("three")).status, "completed");
    await third.close();
    assert.notEqual(seen[0]!.key, seen[2]!.key);
    assert.equal(seen[2]!.key, seen[4]!.key);
    assert.deepEqual(seen[4]!.messages.slice(0, seen[2]!.messages.length), seen[2]!.messages);
  } finally { store.close(); }
});

test("failed runtime transition rolls back the baseline and a retry changes it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-transition-failure-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "retry" }).id;
  const adapter = (model: string): ProviderAdapter => ({ modelConfig: {
    agentName: "agent", provider: "ollama", method: "openai-chat-completions", model },
    generate: async () => ({ text: "done", toolCalls: [], finishReason: "stop" }) });
  const attach = (model: string) => createAgent({ cwd: root, provider: adapter(model), system: "system",
    persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const first = attach("model-a");
    assert.equal((await first.run("one")).status, "completed");
    const previousRevision = first.contextRevision;
    const previousHistory = first.transcript;
    await first.close();
    store.database.exec("CREATE TRIGGER fail_runtime BEFORE UPDATE OF runtime_digest ON sessions BEGIN SELECT RAISE(ABORT, 'blocked transition'); END");
    assert.throws(() => attach("model-b"), /blocked transition/);
    store.database.exec("DROP TRIGGER fail_runtime");
    assert.equal(store.database.prepare("SELECT model_id FROM sessions WHERE id = ?").get(id)?.model_id, "model-a");
    const second = attach("model-b");
    assert.equal(second.contextRevision, previousRevision + 1);
    assert.deepEqual(second.transcript, previousHistory);
    await second.close();
    const third = attach("model-b");
    assert.equal(third.contextRevision, second.contextRevision);
    await third.close();
  } finally { store.close(); }
});
