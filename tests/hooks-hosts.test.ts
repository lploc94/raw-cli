import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
import { acpUpdate, storedAcpUpdates } from "../src/sessions/display.js";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { HistoryView } from "../src/sessions/view.js";

test("dashboard operations persist successful hook receipts; config changes apply on resume", async () => {
  const f = await dashboardFixture({ responses: [
    { frames: [openAiFrame({ content: "one" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "two" }, "stop"), openAiDone] },
  ] });
  try {
    const folder = join(dirname(f.configPath), "hooks", "audit"); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "hook.json"), JSON.stringify({ protocol_version: 2, name: "audit", command: "node",
      args: ["./audit.mjs"], events: [{ name: "UserPromptSubmit" }, { name: "Stop" }] }));
    writeFileSync(join(folder, "audit.mjs"), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'));\n");
    (f.config.agents.raw as Record<string, unknown>).hooks = { use: ["agent/audit"] };
    writeFileSync(f.configPath, JSON.stringify(f.config));
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    for (const key of ["first", "second"]) {
      const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
        { clientRequestId: key, kind: "turn", agent: "raw", input: key });
      assert.equal((await f.wait(op.id)).state, "completed");
    }
    const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
    assert.deepEqual(history.items.filter(item => item.hook).map(item => `${item.hook!.event}:${item.hook!.outcome}`),
      ["UserPromptSubmit:continued", "Stop:continued", "UserPromptSubmit:continued", "Stop:continued"]);
    assert.equal(f.provider.requests.length, 2);
  } finally { await f.close(); }
});

test("ACP live and replay projections expose hook receipt without adding model content", () => {
  const event = { type: "hook_event" as const, id: "agent/audit", event: "PreToolUse" as const,
    outcome: "continued" as const, durationMs: 3, message: "checked" };
  const live = acpUpdate(event);
  assert.equal(live?.sessionUpdate, "agent_thought_chunk");
  const stored = storedAcpUpdates({ sessionId: "s", sequence: 1, kind: "hook_event",
    status: "complete", createdAt: Date.now(), payload: { ...event } });
  assert.deepEqual(stored, [live]);
});

test("ACP session lifecycle and prompt emit selected hook receipts to the peer", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-hook-acp-"));
  const configPath = join(root, "raw.json"), folder = join(root, "hooks", "audit");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hook.json"), JSON.stringify({ protocol_version: 2, name: "audit", command: "node", args: ["./audit.mjs"],
    events: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].map(name => ({ name })) }));
  writeFileSync(join(folder, "audit.mjs"), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'));\n");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw",
    models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { raw: { model: "local", tools: { use: [] }, hooks: { use: ["agent/audit"] } } } }));
  const runtime = await loadConfig({ configPath, requireModel: true,
    env: { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") } });
  const server = createAcpServer({ runtime, storeOptions: { env: { XDG_STATE_HOME: join(root, "state") } },
    providerFactory: () => ({ modelConfig: runtime.modelConfig!,
      generate: async () => ({ text: "done", toolCalls: [], finishReason: "stop" }) }) });
  const peer = client({ name: "hook-peer" });
  const updates: string[] = [];
  peer.onNotification("session/update", ({ params }) => {
    if (params.update.sessionUpdate === "agent_thought_chunk" && params.update.content.type === "text")
      updates.push(params.update.content.text);
  });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.ok(updates.some(text => text.includes("SessionStart: continued")));
    assert.ok(updates.some(text => text.includes("UserPromptSubmit: continued")));
    assert.ok(updates.some(text => text.includes("Stop: continued")));
    await server.close();
    assert.ok(updates.some(text => text.includes("SessionEnd: continued")));
  } finally { connection.close(); await server.close(); }
});
