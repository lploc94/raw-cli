import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard, type DashboardOptions } from "../../src/dashboard/server.js";
import type { SessionOperation } from "../../src/sessions/operations.js";
import { startMockProvider, openAiDone, openAiFrame, type MockResponse } from "./mock-provider.js";

export async function dashboardFixture(options: { responses?: MockResponse[]; agent?: Record<string, unknown>; attach?: DashboardOptions["attach"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-flow-"));
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") };
  const configPath = join(env.XDG_CONFIG_HOME, "raw", "config.json"); mkdirSync(join(env.XDG_CONFIG_HOME, "raw"), { recursive: true });
  const provider = await startMockProvider(options.responses ?? [{ frames: [openAiFrame({ content: "answer" }, "stop"), openAiDone] }]);
  const config = { default_agent: "raw", models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture",
    api_key: "fixture-key", base_url: provider.url, context_window_tokens: 8192 } },
  agents: { raw: { model: "fixture", system_prompt: "Original prompt", tools: { use: [] }, request_timeout_ms: 5000, ...options.agent } } };
  writeFileSync(configPath, JSON.stringify(config));
  const server = await startDashboard({ port: 0, cwd: root, configPath, env, ...(options.attach ? { attach: options.attach } : {}) });
  const api = (path: string, method = "GET", body?: unknown) => fetch(`${server.url}/api${path}`, {
    method, headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await api(path, method, body); const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result as T;
  };
  const wait = async (id: string): Promise<SessionOperation> => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const op = await json<SessionOperation>(`/operations/${id}`);
      if (["completed", "max_steps", "cancelled", "error", "interrupted"].includes(op.state)) return op;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("operation did not finish");
  };
  return { root, env, configPath, config, provider, server, api, json, wait,
    async close() { await server.close(); await provider.close(); rmSync(root, { recursive: true, force: true }); } };
}

export async function eventStream(server: Awaited<ReturnType<typeof startDashboard>>, sessionId: string, cursor?: string) {
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${server.token}`,
    ...(cursor ? { "Last-Event-ID": cursor } : {}) }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
  assert.equal(response.status, 200); const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<{ id: string; type: string; data: Record<string, unknown>; sequence: number }> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = frame.split("\n").find((value) => value.startsWith("data: "));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const result = await reader.read(); if (result.done) throw new Error("event stream closed");
      buffer += decoder.decode(result.value, { stream: true });
    }
  };
  return { next, close() { controller.abort(); void reader.cancel().catch(() => {}); } };
}
