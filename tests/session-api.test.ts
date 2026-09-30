import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSession, getSessionHistory, listSessions, openSessionStore, resumeSession } from "../src/index.js";
import { createTestToolRegistry } from "./fixtures/registry.js";
import type { ProviderAdapter } from "../src/llm/types.js";

test("library session APIs page history and resume with an owned store lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-api-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: root } };
  const seed = openSessionStore(storeOptions);
  const saved = seed.createSession({ cwd, title: "library" });
  seed.appendHistory({ sessionId: saved.id, kind: "user", payload: { input: "hello" } });
  seed.close();

  assert.equal(listSessions({ cwd, storeOptions }).items[0]?.id, saved.id);
  assert.equal(getSessionHistory({ sessionId: saved.id, storeOptions }).items[0]?.kind, "user");

  const provider = {
    modelConfig: { agentName: "fixture", provider: "openai", method: "openai-chat-completions", model: "fixture" },
    async *complete() { yield { type: "text_delta", text: "done" }; },
  } as unknown as ProviderAdapter;
  const handle = resumeSession({ sessionId: saved.id, storeOptions,
    agentOptions: { provider, registry: createTestToolRegistry(), cwd } });
  assert.equal(handle.session.id, saved.id);
  assert.equal(handle.agent.cwd, cwd);
  await handle.close();

  await deleteSession({ sessionId: saved.id, storeOptions });
  assert.equal(listSessions({ cwd, storeOptions }).items.length, 0);
});

test("SDK resume applies current provider, tool view and config path on one session ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-session-api-transition-"));
  const storeOptions = { env: { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  const seed = openSessionStore(storeOptions);
  const id = seed.createSession({ cwd: root, title: "transition", configPath: "/old/config.json" }).id;
  seed.close();
  const requests: Array<{ key: string | undefined; messages: readonly unknown[] }> = [];
  const attach = (model: string, configPath: string) => resumeSession({ sessionId: id, storeOptions,
    agentOptions: { provider: { modelConfig: { agentName: "fixture", provider: "openai",
      method: "openai-chat-completions", model }, generate: async (request) => {
      requests.push({ key: request.cacheKey, messages: structuredClone(request.messages) });
      return { text: "done", toolCalls: [], finishReason: "stop" };
    } }, registry: createTestToolRegistry(), whitelist: [], configPath } });
  const first = attach("one", "/old/config.json");
  assert.equal((await first.agent.run("one")).status, "completed");
  await first.close();
  const second = attach("two", "/new/config.json");
  assert.equal(second.session.configPath, "/new/config.json");
  assert.equal((await second.agent.run("two")).status, "completed");
  await second.close();
  const third = attach("two", "/new/config.json");
  assert.equal((await third.agent.run("three")).status, "completed");
  await third.close();
  assert.notEqual(requests[0]?.key, requests[1]?.key);
  assert.equal(requests[1]?.key, requests[2]?.key);
  assert.deepEqual(requests[2]?.messages.slice(0, requests[1]!.messages.length), requests[1]?.messages);
  const inspect = openSessionStore(storeOptions);
  try { assert.equal(inspect.getSession(id)?.configPath, "/new/config.json"); }
  finally { inspect.close(); }
});
