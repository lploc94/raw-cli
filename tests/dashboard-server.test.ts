import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startDashboard } from "../src/dashboard/server.js";
import { openSessionStore } from "../src/sessions/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-server-"));
  const assetsRoot = join(root, "assets"); mkdirSync(join(assetsRoot, "assets"), { recursive: true });
  writeFileSync(join(assetsRoot, "index.html"), "<!doctype html><title>Raw fixture</title>");
  writeFileSync(join(assetsRoot, "assets", "app.js"), "console.log('fixture')");
  return { root, options: { port: 0, cwd: root, assetsRoot,
    env: { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") } },
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
async function rawGet(url: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { path, headers }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }); req.on("error", reject); req.end();
  });
}

test("loopback dashboard boots without config/credentials and authenticates every API route", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(new URL(server.launchUrl).hash, `#token=${server.token}`);
    assert.equal((await fetch(`${server.url}/api/bootstrap`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/bootstrap?token=${server.token}`)).status, 401);
    const headers = { Authorization: `Bearer ${server.token}` };
    const response = await fetch(`${server.url}/api/bootstrap`, { headers }); assert.equal(response.status, 200);
    const body = await response.json() as { config: { exists: boolean; valid: boolean }; store: { available: boolean } };
    assert.equal(body.config.exists, false); assert.equal(body.store.available, true);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(server.token));
    assert.equal((await fetch(`${server.url}/api/bootstrap`, { headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
    assert.equal((await rawGet(server.url, "/api/bootstrap", { ...headers, Host: "evil.example" })).status, 403);
    assert.equal((await fetch(`${server.url}/api/unknown`, { headers })).status, 404);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally { await server.close(); f.cleanup(); }
});

test("known page refresh serves bundled entry but unknown assets/traversal never do", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  try {
    for (const path of ["/", "/chat/some-session", "/settings/appearance", "/agents/raw", "/library/tools/agent%2Fexample", "/library/hooks", "/library/hooks/local%2Fguard", "/library/typo", "/library/typo/x"]) {
      const response = await fetch(server.url + path); assert.equal(response.status, 200, path); assert.match(await response.text(), /Raw fixture/);
      assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    }
    assert.equal((await fetch(`${server.url}/assets/app.js`)).status, 200);
    assert.equal((await fetch(`${server.url}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${server.url}/not-a-page`)).status, 404);
    assert.equal((await fetch(`${server.url}/library/a/b/c`)).status, 404);
    assert.notEqual((await rawGet(server.url, "/assets/%2e%2e/%2e%2e/secret")).status, 200);
  } finally { await server.close(); f.cleanup(); }
});

test("invalid config stays repairable, occupied port fails, and restart rejects the old token", async () => {
  const f = fixture(); const configPath = join(f.root, "broken.json"); writeFileSync(configPath, "{broken");
  const server = await startDashboard({ ...f.options, configPath });
  const oldToken = server.token; const port = server.port;
  try {
    const response = await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.match(JSON.stringify(await response.json()), /invalid JSON config/);
    await assert.rejects(startDashboard({ ...f.options, port }), /port|address.*use|EADDRINUSE/i);
  } finally { await server.close(); }
  const restarted = await startDashboard({ ...f.options, port });
  try { assert.equal((await fetch(`${restarted.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401); }
  finally { await restarted.close(); f.cleanup(); }
});

test("JSON adapter rejects malformed and oversized data before a route mutation", async () => {
  const f = fixture(); let writes = 0;
  const server = await startDashboard({ ...f.options, routes: () => [async (request, response, context) => {
    if (request.url !== "/api/test-write") return false;
    const body = await context.readJson(request); writes++; context.json(response, 200, body); return true;
  }] });
  try {
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${server.url}/api/test-write`, { method: "POST", headers, body: "{bad" })).status, 400);
    assert.equal((await fetch(`${server.url}/api/test-write`, { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(1024 * 1024) }) })).status, 413);
    assert.equal(writes, 0);
    assert.equal((await fetch(`${server.url}/api/test-write`, { method: "POST", headers, body: '{"ok":true}' })).status, 200);
    assert.equal(writes, 1);
  } finally { await server.close(); f.cleanup(); }
});

test("store failure is scoped and bootstrap never returns config credentials or prompts", async () => {
  const f = fixture(); const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { m: { provider: "ollama", method: "openai-chat-completions",
    model_id: "fixture", api_key: "BOOTSTRAP_SECRET_SENTINEL" } }, agents: { raw: { model: "m", tools: { use: [] }, system_prompt: "BOOTSTRAP_PROMPT_SENTINEL" } } }));
  const server = await startDashboard({ ...f.options, configPath, storeFactory: () => { throw new Error("store unavailable fixture"); } });
  try {
    const response = await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` } });
    const body = await response.text(); assert.equal(response.status, 200); assert.match(body, /store unavailable fixture/);
    assert.doesNotMatch(body, /BOOTSTRAP_SECRET_SENTINEL|BOOTSTRAP_PROMPT_SENTINEL/);
    assert.equal((await fetch(server.url)).status, 200);
  } finally { await server.close(); f.cleanup(); }
});

test("abort during listen cannot leave a late listener behind", async () => {
  const f = fixture(); const initial = await startDashboard(f.options); const port = initial.port; await initial.close();
  const controller = new AbortController();
  const starting = startDashboard({ ...f.options, port, signal: controller.signal }); controller.abort();
  try {
    await assert.rejects(starting, /cancelled/);
    const next = await startDashboard({ ...f.options, port }); await next.close();
  } finally { f.cleanup(); }
});

test("shutdown cancels an owned startup child and releases the writer before closing the store", async () => {
  const f = fixture(); let child: ReturnType<typeof spawn> | undefined; let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const server = await startDashboard({ ...f.options, attach: async ({ signal }) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn"); ready();
    return new Promise<never>((_resolve, reject) => {
      const stop = () => { child!.once("exit", () => reject(new Error("startup stopped"))); child!.kill("SIGTERM"); };
      signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    });
  } });
  try {
    const session = server.context.store!.createSession({ cwd: f.root, title: "startup" });
    server.context.operations!.submit({ sessionId: session.id, kind: "turn", input: "start", clientRequestId: "start", agentName: "raw", configPath: server.context.configPath });
    await started; await server.close();
    assert.ok(child?.exitCode !== null || child?.signalCode !== null);
    const store = openSessionStore({ env: f.options.env });
    try { assert.equal(store.sessionIsBusy(session.id), false); assert.equal(store.listOperations(session.id)[0]?.state, "cancelled"); }
    finally { store.close(); }
  } finally { child?.kill("SIGKILL"); await server.close(); f.cleanup(); }
});
