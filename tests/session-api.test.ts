import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSession, getSessionHistory, listSessions, openSessionStore, resumeSession } from "../src/index.js";
import { createToolRegistry } from "../src/tools/registry.js";
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
    profile: { name: "fixture", provider: "openai", method: "openai-chat-completions", model: "fixture" },
    async *complete() { yield { type: "text_delta", text: "done" }; },
  } as unknown as ProviderAdapter;
  const handle = resumeSession({ sessionId: saved.id, storeOptions,
    agentOptions: { provider, registry: createToolRegistry(), cwd } });
  assert.equal(handle.session.id, saved.id);
  assert.equal(handle.agent.cwd, cwd);
  await handle.close();

  deleteSession({ sessionId: saved.id, storeOptions });
  assert.equal(listSessions({ cwd, storeOptions }).items.length, 0);
});
