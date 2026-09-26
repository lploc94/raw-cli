import { appendFileSync } from "node:fs";
import { createAgent } from "../../src/agent.js";
import { SessionOperations } from "../../src/sessions/operations.js";
import { openSessionStore } from "../../src/sessions/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const [root, sessionId, configPath, sentinel] = process.argv.slice(2) as [string, string, string, string];
const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
const registry = new ToolRegistry();
registry.register({ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() {
  appendFileSync(sentinel, "1");
  process.send?.({ effect: true, operationId: store.listOperations(sessionId)[0]!.id });
  return await new Promise<never>(() => {});
} });
const modelConfig = { agentName: "test", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
const service = new SessionOperations({ store, attach: async ({ owner, operation }) => ({
  agent: createAgent({ cwd: root, registry, provider: { modelConfig, async generate() {
    return { text: "", toolCalls: [{ id: "side-effect", name: "effect", arguments: {} }], finishReason: "tool_calls" };
  } }, persistence: { store, sessionId, surface: "web", owner, ownership: "host", operationId: operation.id } }),
  modelConfig, compactOptions: {}, async close() {},
}) });
service.submit({ sessionId, clientRequestId: "first", kind: "turn", input: "do it", agentName: "test", configPath });
