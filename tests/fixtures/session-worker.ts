import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../../src/agent.js";
import type { ProviderAdapter } from "../../src/llm/types.js";
import { openSessionStore } from "../../src/sessions/store.js";
import { createTestToolRegistry } from "./registry.js";

const [mode, root, sessionId, marker] = process.argv.slice(2);
if (!mode || !root || !sessionId || !marker) throw new Error("worker arguments missing");
const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });

if (mode === "hold") {
  store.claimSession(sessionId);
  process.stdout.write("READY\n");
  process.stdin.resume();
} else if (mode === "stage") {
  const owner = store.claimSession(sessionId);
  const originalExec = store.database.exec.bind(store.database);
  let paused = false;
  store.database.exec = (sql: string) => {
    if (!paused && sql === "BEGIN IMMEDIATE") {
      paused = true;
      writeFileSync(marker, "staged");
      while (!existsSync(marker + ".go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return originalExec(sql);
  };
  store.appendAgentMessage(sessionId, owner, { role: "user", content: "z".repeat(70_000) });
  store.releaseSession(sessionId, owner);
  process.stdout.write("COMMITTED\n");
  store.close();
} else if (mode === "tool" || mode === "tool_done") {
  const registry = createTestToolRegistry();
  registry.register({ name: "side_effect", description: "Side effect", inputSchema: { type: "object" },
    handler: async () => {
      appendFileSync(marker, "x");
      if (mode === "tool") await new Promise<void>(() => {});
      return { isError: false, content: [{ type: "text", text: "done" }] };
    } });
  let requests = 0;
  const provider: ProviderAdapter = { profile: { name: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => {
      if (++requests === 1) return { text: "", toolCalls: [{ id: "call", name: "side_effect", arguments: {} }], finishReason: "tool_calls" };
      await new Promise<void>(() => {});
      return { text: "never", toolCalls: [], finishReason: "stop" };
    } };
  const agent = createAgent({ cwd: root, provider, registry, system: "system", persistence: { store, sessionId, surface: "cli" } });
  process.stdin.resume();
  void agent.run("execute");
} else throw new Error("unknown worker mode");
