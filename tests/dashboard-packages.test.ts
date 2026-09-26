import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { packPackage } from "../src/packages/archive.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

export function packageFixture(root: string, version = "1.0.0", value = "old package") {
  const source = join(root, `package-${version}-${value.replaceAll(" ", "-")}`);
  cpSync(join(process.cwd(), "examples/packages/mixed-kit"), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, "raw-package.json"), "utf8"));
  manifest.name = "@test/dashboard-kit"; manifest.version = version;
  manifest.inputs = { type: "object", properties: { prompt: { type: "string", description: "Your system prompt" } }, required: ["prompt"] };
  writeFileSync(join(source, "raw-package.json"), JSON.stringify(manifest));
  const agent = JSON.parse(readFileSync(join(source, "agents/helper.json"), "utf8"));
  delete agent.system_prompt_file; agent.system_prompt = { $input: "prompt" }; agent.tools.use = ["#tools/echo", "builtin/list_skills", "builtin/load_skill"];
  writeFileSync(join(source, "agents/helper.json"), JSON.stringify(agent));
  writeFileSync(join(source, "tools/echo/index.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "package-imported"))},'yes'); export async function handler(){return {isError:false,content:[{type:'text',text:${JSON.stringify(value)}}]};}`);
  return source;
}

test("inspect/install/activate a mixed package is passive and recipient-owned after source removal", async () => {
  const f = await dashboardFixture();
  try {
    const source = packageFixture(f.root);
    const before = readFileSync(f.configPath, "utf8"), stage = await f.json<any>("/packages/inspect", "POST", { path: source });
    assert.deepEqual(stage.report.exports.agents, ["helper"]); assert.equal(stage.inputs.properties.prompt.type, "string");
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "kit", action: "install" });
    rmSync(source, { recursive: true });
    assert.equal(readFileSync(f.configPath, "utf8"), before); assert.equal(existsSync(join(f.root, "package-imported")), false);
    const config = await f.json<any>("/config");
    assert.equal((await f.api("/packages/kit/agent", "POST", { revision: config.revision, name: "writer", exportName: "helper", model: "fixture", inputs: { prompt: 5 } })).status, 422);
    assert.equal(readFileSync(f.configPath, "utf8"), before);
    await f.json("/packages/kit/agent", "POST", { revision: config.revision, name: "writer", exportName: "helper", model: "fixture", inputs: { prompt: "Recipient prompt" } });
    assert.equal(JSON.parse(readFileSync(f.configPath, "utf8")).default_agent, "raw");
    const detail = await f.json<any>("/packages/kit"); assert.ok(detail.usedBy.some((s: string) => s.includes("agents.writer")));
    assert.equal((await f.api("/packages/kit", "DELETE")).status, 409);
    const session = await f.json<any>("/sessions", "POST", { cwd: f.root, agent: "writer" });
    const op = await f.json<any>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "run", kind: "turn", agent: "writer", input: "hello" });
    assert.equal((await f.wait(op.id)).state, "completed"); assert.equal(existsSync(join(f.root, "package-imported")), true);
    assert.equal((f.provider.requests[0]!.body as any).messages[0].content, "Recipient prompt");
  } finally { await f.close(); }
});

test("archive upload is bounded, malformed staging is removed, and install does not require model keys", async () => {
  const f = await dashboardFixture();
  try {
    const source = packageFixture(f.root), archive = join(f.root, "kit.rawpkg"); await packPackage(source, archive);
    const upload = (body: Buffer) => fetch(f.server.url + "/api/packages/upload", { method: "POST", headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) });
    assert.equal((await upload(Buffer.from("bad zip"))).status, 422);
    assert.deepEqual(await f.json("/packages"), []);
    const response = await upload(readFileSync(archive)); assert.equal(response.status, 201);
    const stage = await response.json() as any; assert.equal(stage.canLink, false); assert.ok(stage.sha256);
    const config: any = structuredClone(f.config); delete config.models.fixture.api_key; writeFileSync(f.configPath, JSON.stringify(config));
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "uploaded", action: "install" });
    const downloaded = await f.api(`/packages/stages/${stage.id}/download`); assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), readFileSync(archive));
    await f.json(`/packages/stages/${stage.id}`, "DELETE"); assert.equal((await f.api(`/packages/stages/${stage.id}/download`)).status, 404);
    await f.json("/packages/uploaded", "DELETE"); assert.equal(existsSync(join(f.root, "package-imported")), false);
  } finally { await f.close(); }
});

test("component exports bind without changing default, with explicit readable vars and MCP discovery", async () => {
  const f = await dashboardFixture();
  try {
    const stage = await f.json<any>("/packages/inspect", "POST", { path: packageFixture(f.root) });
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "kit", action: "install" });
    for (const [kind, exportName, name] of [["tools", "echo", "echo_alias"], ["skills", "repo-review", "review"], ["vars", "host_label", "host"], ["var_providers", "host_label", "provider"], ["mcp", "search", "search"]]) {
      const config = await f.json<any>("/config");
      await f.json("/packages/kit/component", "POST", { revision: config.revision, kind, exportName, name, agent: "raw", inputs: {} });
    }
    const config = JSON.parse(readFileSync(f.configPath, "utf8")); assert.equal(config.default_agent, "raw");
    assert.ok(config.agents.raw.tools.use.some((x: any) => (x.ref ?? x) === "pkg/kit/tools/echo"));
    assert.equal(config.vars.host.from, "pkg/kit/vars/host_label"); assert.equal(existsSync(join(f.root, "package-imported")), false);
    const revision = (await f.json<any>("/config")).revision;
    const check = await f.json<any>("/checks", "POST", { revision, kind: "mcp", agent: "raw", name: "search" });
    let done: any;
    for (let i = 0; i < 400; i++) { done = await f.json(`/checks/${check.id}`); if (done.state !== "running") break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(done.state, "completed", JSON.stringify(done)); assert.equal(done.result.tools[0].originalName, "echo_text");
    assert.equal(done.result.tools[0].identity, "@test/dashboard-kit#mcp/search/echo_text");
    const reading = await f.json<any>("/checks", "POST", { revision, kind: "var", agent: "raw", name: "host" });
    for (let i = 0; i < 400; i++) { done = await f.json(`/checks/${reading.id}`); if (done.state !== "running") break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(done.state, "completed", JSON.stringify(done)); assert.equal(done.result.name, "host"); assert.equal(typeof done.result.value, "string");
  } finally { await f.close(); }
});

test("export downloads relocate and package updates resume one ID with unchanged follow-up prefix", async () => {
  const answer = { frames: [openAiFrame({ content: "answer" }, "stop"), openAiDone] };
  const f = await dashboardFixture({ responses: [answer, answer, answer, answer] });
  try {
    const source = packageFixture(f.root); let stage = await f.json<any>("/packages/inspect", "POST", { path: source });
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "kit", action: "install" });
    await f.json(`/packages/stages/${stage.id}`, "DELETE");
    await f.json("/packages/kit/agent", "POST", { revision: (await f.json<any>("/config")).revision, name: "writer", exportName: "helper", model: "fixture", inputs: { prompt: "Prompt" } });
    const session = await f.json<any>("/sessions", "POST", { cwd: f.root, agent: "writer" });
    const run = async (key: string) => f.wait((await f.json<any>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: key, kind: "turn", agent: "writer", input: key })).id);
    assert.equal((await run("one")).state, "completed");
    const old = await f.json<any>("/packages/kit");
    const bad = packageFixture(f.root, "2.0.0", "bad"); const manifest = JSON.parse(readFileSync(join(bad, "raw-package.json"), "utf8")); delete manifest.exports.agents;
    writeFileSync(join(bad, "raw-package.json"), JSON.stringify(manifest)); stage = await f.json<any>("/packages/inspect", "POST", { path: bad });
    assert.equal((await f.api("/packages/install", "POST", { stageId: stage.id, alias: "kit", action: "update" })).status, 422);
    assert.equal((await f.json<any>("/packages/kit")).entry.digest, old.entry.digest); await f.json(`/packages/stages/${stage.id}`, "DELETE");
    const next = packageFixture(f.root, "2.0.0", "new package"); stage = await f.json<any>("/packages/inspect", "POST", { path: next });
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "kit", action: "update" }); await f.json(`/packages/stages/${stage.id}`, "DELETE");
    assert.equal((await run("two")).state, "completed"); assert.equal((await run("three")).state, "completed");
    const requests = f.provider.requests.map(r => r.body as any); assert.notEqual(requests[0].prompt_cache_key, requests[1].prompt_cache_key); assert.equal(requests[1].prompt_cache_key, requests[2].prompt_cache_key);
    const exported = await f.json<any>("/packages/export", "POST", { revision: (await f.json<any>("/config")).revision, agent: "writer", name: "@test/relocated", version: "1.0.0", includeLiterals: true, includeFiles: [] });
    const archive = join(f.root, "export.rawpkg"); writeFileSync(archive, Buffer.from(await (await f.api(`/packages/stages/${exported.id}/download`)).arrayBuffer()));
    rmSync(source, { recursive: true }); rmSync(next, { recursive: true });
    const relocated = await f.json<any>("/packages/inspect", "POST", { path: archive });
    await f.json("/packages/install", "POST", { stageId: relocated.id, alias: "relocated", action: "install" });
    await f.json("/packages/relocated/agent", "POST", { revision: (await f.json<any>("/config")).revision, name: "recipient", exportName: "writer", model: "fixture", inputs: {} });
    const recipient = await f.json<any>("/sessions", "POST", { cwd: f.root, agent: "recipient" });
    const op = await f.json<any>(`/sessions/${recipient.id}/operations`, "POST", { clientRequestId: "relocated", kind: "turn", agent: "recipient", input: "after source removal" });
    assert.equal((await f.wait(op.id)).state, "completed");
    assert.equal((await f.json<any>(`/sessions/${session.id}`)).session.id, session.id);
  } finally { await f.close(); }
});

test("standalone packages, linked inspection, independent forks and staging cleanup use the existing stores", async () => {
  const f = await dashboardFixture();
  const staging = join(f.env.XDG_STATE_HOME, "raw/dashboard-packages", f.server.context.instanceId);
  try {
    for (const kind of ["tool-only", "skill-only"]) {
      const stage = await f.json<any>("/packages/inspect", "POST", { path: join(process.cwd(), "examples/packages", kind) });
      await f.json("/packages/install", "POST", { stageId: stage.id, alias: kind, action: "install" });
      assert.equal(stage.report.exports.agents.length, 0); await f.json(`/packages/stages/${stage.id}`, "DELETE");
    }
    const source = packageFixture(f.root), stage = await f.json<any>("/packages/inspect", "POST", { path: source });
    await f.json("/packages/install", "POST", { stageId: stage.id, alias: "linked", action: "link" });
    const before = readdirSync(join(f.env.XDG_DATA_HOME, "raw/packages/sha256")).sort();
    assert.equal((await f.json<any>("/packages/linked")).entry.source.kind, "link");
    assert.deepEqual(readdirSync(join(f.env.XDG_DATA_HOME, "raw/packages/sha256")).sort(), before);
    const destination = join(f.root, "fork"); await f.json("/packages/linked/fork", "POST", { out: destination });
    writeFileSync(join(destination, "tools/echo/helper.mjs"), 'export const prefix="independent";');
    assert.notEqual(readFileSync(join(destination, "tools/echo/helper.mjs"), "utf8"), readFileSync(join(source, "tools/echo/helper.mjs"), "utf8"));
    assert.equal(existsSync(join(f.root, "package-imported")), false);
    await f.json(`/packages/stages/${stage.id}`, "DELETE"); assert.deepEqual(readdirSync(staging), []);
    await f.server.close(); assert.equal(existsSync(staging), false);
  } finally { await f.close(); }
});

test("oversized and interrupted uploads never publish staging or aliases", async () => {
  const f = await dashboardFixture(); const { request } = await import("node:http");
  const staging = join(f.env.XDG_STATE_HOME, "raw/dashboard-packages", f.server.context.instanceId);
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(f.server.url + "/api/packages/upload", { method: "POST", headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "application/octet-stream", "Content-Length": 128 * 1024 * 1024 + 1 } }, res => { res.resume(); res.on("end", () => { resolve(res.statusCode); req.destroy(); }); });
      req.on("error", error => { if (!(error as any).code?.includes("RESET")) reject(error); }); req.flushHeaders();
    }); assert.equal(status, 413);
    const req = request(f.server.url + "/api/packages/upload", { method: "POST", headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "application/octet-stream" } });
    req.on("error", () => {}); req.write(Buffer.from("incomplete"));
    for (let i = 0; i < 200 && !existsSync(staging); i++) await new Promise(r => setTimeout(r, 5));
    req.destroy();
    for (let i = 0; i < 200 && readdirSync(staging).length; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(readdirSync(staging), []); assert.deepEqual(await f.json("/packages"), []);
  } finally { await f.close(); }
});

test("removal and update see package references inside agent selection overrides", async () => {
  const f = await dashboardFixture();
  try {
    for (const [alias, path] of [["kit", packageFixture(f.root)], ["extra", join(process.cwd(), "examples/packages/tool-only")]]) {
      const stage = await f.json<any>("/packages/inspect", "POST", { path }); await f.json("/packages/install", "POST", { stageId: stage.id, alias, action: "install" }); await f.json(`/packages/stages/${stage.id}`, "DELETE");
    }
    const entry = await f.json<any>("/packages/extra"), tool = entry.report.exports.tools[0];
    let config = await f.json<any>("/config");
    await f.json("/packages/kit/agent", "POST", { revision: config.revision, name: "writer", exportName: "helper", model: "fixture", inputs: { prompt: "Prompt" } });
    config = await f.json<any>("/config");
    await f.json("/agents", "POST", { revision: config.revision, action: "patch", name: "writer", value: { overrides: { tools: { use: [`pkg/extra/tools/${tool}`] }, skills: { use: [] } } } });
    const response = await f.api("/packages/extra", "DELETE"); assert.equal(response.status, 409);
    assert.match(JSON.stringify(await response.json()), /agents.writer.overrides.tools.use/);
    const replacement = join(f.root, "renamed-export"); cpSync(join(process.cwd(), "examples/packages/tool-only"), replacement, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(replacement, "raw-package.json"), "utf8")); manifest.exports.tools = { renamed: Object.values(manifest.exports.tools)[0] };
    writeFileSync(join(replacement, "raw-package.json"), JSON.stringify(manifest));
    const stage = await f.json<any>("/packages/inspect", "POST", { path: replacement });
    assert.equal((await f.api("/packages/install", "POST", { stageId: stage.id, alias: "extra", action: "update" })).status, 422);
    assert.equal((await f.json<any>("/packages/extra")).entry.digest, entry.entry.digest);
  } finally { await f.close(); }
});

test("shutdown interrupts an unfinished package JSON request instead of waiting for its body", async () => {
  const f = await dashboardFixture(); const { request } = await import("node:http");
  const req = request(f.server.url + "/api/packages/inspect", { method: "POST", headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "application/json" } });
  req.on("error", () => {}); req.write("{");
  await new Promise(r => setTimeout(r, 30));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([f.server.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("shutdown still waiting for upload body")), 1000); })]); }
  finally { if (timer) clearTimeout(timer); req.destroy(); await f.close(); }
});
