import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { createStarterConfig } from "../src/management/starter.js";

const manifest = (name: string) => JSON.stringify({ api_version: 2, id: name, version: "1.0.0", name,
  description: "Fixture tool", entry: "./index.mjs", input_schema: { type: "object", properties: {}, additionalProperties: false } });
const checkDone = async (f: Awaited<ReturnType<typeof dashboardFixture>>, id: string) => {
  for (let i = 0; i < 400; i++) {
    const row = await f.json<any>(`/checks/${id}`);
    if (row.state !== "running") return row;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("check did not terminate");
};

test("management revisions, strict repair and safe projections preserve credentials and external edits", async () => {
  const f = await dashboardFixture();
  try {
    const current = await f.json<any>("/config");
    assert.equal(current.canonical, true); assert.equal(JSON.stringify(current).includes("fixture-key"), false);
    const model = await f.json<any>("/models/fixture");
    assert.equal(model.credential.present, true); assert.equal(model.value.api_key, undefined);
    const saved = await f.json<any>("/models", "POST", { revision: current.revision, action: "patch", name: "fixture", value: { model_id: "changed" }, credential: { mode: "keep" } });
    assert.equal(JSON.parse(readFileSync(f.configPath, "utf8")).models.fixture.api_key, "fixture-key");
    assert.equal((await f.api("/config", "PATCH", { revision: current.revision, patch: { default_agent: "raw" } })).status, 409);
    const bytes = readFileSync(f.configPath, "utf8");
    assert.equal((await f.api("/config/document", "PUT", { revision: saved.revision, source: bytes.slice(0, -1) + ",}" })).status, 422);
    assert.equal(readFileSync(f.configPath, "utf8"), bytes);
    assert.equal((await f.api("/agents", "POST", { action: "delete", name: "raw" })).status, 400);
    writeFileSync(f.configPath, "{broken");
    assert.equal((await f.json<any>("/config")).valid, false);
    const repair = await f.json<any>("/config/document");
    await f.json("/config/document", "PUT", { revision: repair.revision, source: bytes });
    assert.equal((await f.json<any>("/config")).valid, true);
  } finally { await f.close(); }
});

test("resource edits support legal object-key names and enforce model/default dependencies", async () => {
  const f = await dashboardFixture();
  try {
    let rev = (await f.json<any>("/config")).revision;
    const created = await f.json<any>("/agents", "POST", { revision: rev, action: "create", name: "__proto__", value: { model: "fixture", tools: { use: [] } } });
    assert.ok(created.agents.includes("__proto__")); rev = created.revision;
    assert.equal((await f.api("/models", "POST", { revision: rev, action: "delete", name: "fixture" })).status, 409);
    assert.equal((await f.api("/agents", "POST", { revision: rev, action: "delete", name: "raw" })).status, 409);
    const renamed = await f.json<any>("/agents", "POST", { revision: rev, action: "rename", name: "__proto__", newName: "custom" });
    assert.ok(renamed.agents.includes("custom"));
  } finally { await f.close(); }
});

test("config view summarizes each agent without prompts, including object-key names and invalid configs", async () => {
  const f = await dashboardFixture({
    agent: { tools: { use: ["builtin/read_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"], rules: [{ match: "builtin/bash", effect: "deny" }] }, skills: { use: ["builtin/create_skill"] } },
    extraAgents: { bare: { model: "fixture", system_prompt: "Secret bare prompt", tools: { use: [] } } },
  });
  try {
    let view = await f.json<any>("/config");
    assert.equal(view.valid, true, view.diagnostic);
    assert.deepEqual(view.agentSummaries.raw, { model: "fixture", tools: 4, skills: 1, hooks: 0, rules: 1 });
    assert.deepEqual(view.agentSummaries.bare, { model: "fixture", tools: 0, skills: 0, hooks: 0, rules: 0 });
    assert.equal(JSON.stringify(view).includes("Original prompt"), false);
    assert.equal(JSON.stringify(view).includes("Secret bare prompt"), false);
    view = await f.json<any>("/agents", "POST", { revision: view.revision, action: "create", name: "__proto__", value: { model: "fixture", tools: { use: ["builtin/read_file"] } } });
    assert.ok(Object.hasOwn(view.agentSummaries, "__proto__"));
    assert.equal(view.agentSummaries["__proto__"].tools, 1);
    view = await f.json<any>("/config");
    assert.equal(view.agentSummaries["__proto__"].tools, 1);
    writeFileSync(f.configPath, "{broken");
    view = await f.json<any>("/config");
    assert.equal(view.valid, false);
    assert.deepEqual(view.agentSummaries, {});
  } finally { await f.close(); }
});

test("a prompt patch that removes one source and sets the other keeps the new source", async () => {
  const f = await dashboardFixture();
  try {
    let rev = (await f.json<any>("/config")).revision;
    rev = (await f.json<any>("/agents", "POST", { revision: rev, action: "patch", name: "raw", value: { system_prompt: null, system_prompt_file: "prompts/raw.md" } })).revision;
    let agent = JSON.parse(readFileSync(f.configPath, "utf8")).agents.raw;
    assert.equal(agent.system_prompt_file, "prompts/raw.md"); assert.equal(Object.hasOwn(agent, "system_prompt"), false);
    rev = (await f.json<any>("/agents", "POST", { revision: rev, action: "patch", name: "raw", value: { system_prompt_file: null, system_prompt: "Back to text" } })).revision;
    agent = JSON.parse(readFileSync(f.configPath, "utf8")).agents.raw;
    assert.equal(agent.system_prompt, "Back to text"); assert.equal(Object.hasOwn(agent, "system_prompt_file"), false);
    await f.json<any>("/agents", "POST", { revision: rev, action: "patch", name: "raw", value: { system_prompt_file: "other.md" } });
    agent = JSON.parse(readFileSync(f.configPath, "utf8")).agents.raw;
    assert.equal(agent.system_prompt_file, "other.md"); assert.equal(Object.hasOwn(agent, "system_prompt"), false);
  } finally { await f.close(); }
});

test("passive components never import code, per-file conflicts and usages prevent loss", async () => {
  const f = await dashboardFixture(); const sentinel = join(f.root, "imported");
  try {
    await f.json("/components/tools", "POST", { id: "local/probe", files: { "tool.json": manifest("probe"),
      "index.mjs": `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'bad'); export default {};` } });
    const id = encodeURIComponent("local/probe");
    assert.ok((await f.json<any[]>("/components/tools")).some(x => x.id === "local/probe"));
    const file = await f.json<any>(`/components/tools/${id}/file?path=index.mjs`);
    await f.json(`/components/tools/${id}/file?path=index.mjs`, "PUT", { revision: file.revision, source: file.source + "\n// edit" });
    assert.equal((await f.api(`/components/tools/${id}/file?path=index.mjs`, "PUT", { revision: file.revision, source: "stale" })).status, 409);
    assert.equal(existsSync(sentinel), false);
    const config = await f.json<any>("/config");
    const selected = await f.json<any>(`/components/tools/${id}/selection`, "POST", { revision: config.revision, agent: "raw", selected: true });
    assert.equal((await f.api(`/components/tools/${id}`, "DELETE")).status, 409);
    await f.json(`/components/tools/${id}/selection`, "POST", { revision: selected.revision, agent: "raw", selected: false });
    await f.json(`/components/tools/${id}`, "DELETE");
    const fork = await f.json<any>("/components/skills", "POST", { id: "local/config_help", cloneFrom: "builtin/configure_raw" });
    assert.equal(fork.readOnly, false); assert.equal(existsSync(sentinel), false);
  } finally { await f.close(); }
});

test("policy samples use ordered canonical rules with conditional RE2 and never execute", async () => {
  const f = await dashboardFixture();
  try {
    const rules = [{ match: "builtin/bash", effect: "ask", when: { source: "arguments", any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" } }];
    for (const [command, expected] of [["pwd", "allow"], ["rm file", "ask"]]) {
      const result = await f.json<any>("/policy/test", "POST", { identity: "builtin/bash", rules, args: { commands: [{ command }] } });
      assert.equal(result.effect, expected);
    }
    const hidden = await f.json<any>("/policy/test", "POST", { identity: "builtin/bash", rules: [{ match: "builtin/bash", effect: "deny" }, ...rules], args: { commands: [{ command: "rm file" }] } });
    assert.equal(hidden.effect, "deny"); assert.equal(hidden.exposed, false);
    assert.equal((await f.api("/policy/test", "POST", { identity: "builtin/bash", rules: [{ match: "*", effect: "ask", when: { source: "arguments", any: "command", regex: ".*", invented: true } }], args: {} })).status, 422);
    assert.equal(f.provider.requests.length, 0);
  } finally { await f.close(); }
});

test("vars are passive until explicit checks and access=use remains unreadable", async () => {
  const f = await dashboardFixture(); const sentinel = join(f.root, "var-ran");
  try {
    const script = join(f.root, "provider.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; process.stdin.once('data',()=>{writeFileSync(${JSON.stringify(sentinel)},'yes'); console.log(JSON.stringify({value:'var-secret'}));});`);
    const data: any = structuredClone(f.config);
    data.var_providers = { probe: { command: process.execPath, args: [script] } };
    data.vars = { probe: { description: "Test", type: "string", access: "read", source: { kind: "provider", name: "probe" } },
      hidden: { description: "Use only", access: "use", source: { kind: "literal", value: "hidden-secret" } } };
    data.agents.raw.vars = ["probe", "hidden"];
    writeFileSync(f.configPath, JSON.stringify(data));
    const config = await f.json<any>("/config");
    assert.equal(existsSync(sentinel), false); assert.equal(JSON.stringify(config).includes("hidden-secret"), false);
    const check = await f.json<any>("/checks", "POST", { kind: "var", name: "probe", agent: "raw", revision: config.revision });
    const done = await checkDone(f, check.id); assert.equal(done.state, "completed"); assert.equal(done.result.value, "var-secret");
    assert.equal(existsSync(sentinel), true);
    const hidden = await f.json<any>("/checks", "POST", { kind: "var", name: "hidden", agent: "raw", revision: config.revision });
    assert.match((await checkDone(f, hidden.id)).error, /var_read_denied/);
    const diagnostic = JSON.stringify(await f.json("/diagnostics"));
    for (const secret of ["fixture-key", "var-secret", "hidden-secret", script, "Original prompt"]) assert.equal(diagnostic.includes(secret), false);
  } finally { await f.close(); }
});

test("MCP explicit discovery cancels owned startup before reporting terminal", async () => {
  const f = await dashboardFixture(); const pidFile = join(f.root, "mcp-pid");
  try {
    const script = join(f.root, "mcp.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
    const data = { ...f.config, mcp: { servers: { probe: { transport: "stdio", command: process.execPath, args: [script] } } } };
    writeFileSync(f.configPath, JSON.stringify(data));
    const config = await f.json<any>("/config"); assert.equal(existsSync(pidFile), false);
    const check = await f.json<any>("/checks", "POST", { kind: "mcp", name: "probe", agent: "raw", revision: config.revision });
    for (let i = 0; i < 400 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(existsSync(pidFile), true);
    await f.json(`/checks/${check.id}/cancel`, "POST", {});
    assert.equal((await checkDone(f, check.id)).state, "cancelled");
    const pid = Number(readFileSync(pidFile, "utf8")); assert.throws(() => process.kill(pid, 0));
    assert.equal((await f.json<any>(`/checks/${check.id}`)).state, "cancelled");
  } finally { await f.close(); }
});

test("initialize uses the CLI factory and refuses overwrite", async () => {
  const f = await dashboardFixture();
  try {
    unlinkSync(f.configPath); await f.json("/config/initialize", "POST", {});
    assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")), createStarterConfig());
    assert.equal((await f.api("/config/initialize", "POST", {})).status, 409);
  } finally { await f.close(); }
});

test("HTTP source and prompt saves preserve the active snapshot, then change and stabilize resumed turns", async () => {
  const { openAiFrame, openAiDone } = await import("./fixtures/mock-provider.js");
  const call = (name: string, args = {}) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
  const answer = { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] };
  const f = await dashboardFixture({ responses: [call("probe"), answer, call("probe"), call("load_skill", { name: "help-guide" }), answer, answer] });
  const started = join(f.root, "started"), release = join(f.root, "release");
  try {
    const handler = `import {value} from './helper.mjs'; import {writeFileSync,existsSync} from 'node:fs';
      export async function handler(){ writeFileSync(${JSON.stringify(started)},'started'); while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10)); return {isError:false,content:[{type:'text',text:value}]}; }`;
    await f.json("/components/tools", "POST", { id: "local/probe", files: { "tool.json": manifest("probe"), "index.mjs": handler, "helper.mjs": 'export const value="old helper";' } });
    await f.json("/components/skills", "POST", { id: "local/help_guide", files: { "SKILL.md": "---\nname: help-guide\ndescription: Practical test guidance.\n---\nOld guidance.\n" } });
    let config = await f.json<any>("/config");
    config = await f.json<any>("/agents", "POST", { revision: config.revision, action: "patch", name: "raw", value: { tools: { use: ["local/probe", "builtin/list_skills", "builtin/load_skill"] }, skills: { use: ["local/help_guide"] } } });
    const session = await f.json<any>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const run = (key: string) => f.json<any>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: key, kind: "turn", agent: "raw", input: key });
    const first = await run("one");
    for (let i = 0; i < 500 && !existsSync(started); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(existsSync(started), true);
    for (const [kind, id, path, source] of [["tools", "local/probe", "helper.mjs", 'export const value="new helper";'],
      ["skills", "local/help_guide", "SKILL.md", "---\nname: help-guide\ndescription: Practical test guidance.\n---\nNew guidance.\n"]]) {
      const url = `/components/${kind}/${encodeURIComponent(id!)}/file?path=${path}`;
      const before = await f.json<any>(url); await f.json(url, "PUT", { revision: before.revision, source });
    }
    await f.json("/agents", "POST", { revision: config.revision, action: "patch", name: "raw", value: { system_prompt: "New prompt" } });
    writeFileSync(release, "go"); assert.equal((await f.wait(first.id)).state, "completed");
    assert.equal((await f.wait((await run("two")).id)).state, "completed");
    assert.equal((await f.wait((await run("three")).id)).state, "completed");
    const requests = f.provider.requests.map(r => r.body as any);
    assert.equal(requests[0].messages[0].content, "Original prompt"); assert.equal(requests[1].messages[0].content, "Original prompt");
    assert.match(JSON.stringify(requests[1].messages), /old helper/);
    assert.equal(requests[2].messages[0].content, "New prompt"); assert.match(JSON.stringify(requests[3].messages), /new helper/);
    assert.match(JSON.stringify(requests[4].messages), /New guidance/);
    assert.notEqual(requests[0].prompt_cache_key, requests[2].prompt_cache_key);
    assert.equal(requests[4].prompt_cache_key, requests[5].prompt_cache_key);
    assert.deepEqual(requests[5].messages.slice(0, requests[4].messages.length), requests[4].messages);
    assert.equal((await f.json<any>(`/sessions/${session.id}`)).session.id, session.id);
  } finally { writeFileSync(release, "go"); await f.close(); }
});

test("MCP discovery returns original names and canonical identities without calling tools", async () => {
  const f = await dashboardFixture(); const called = join(f.root, "called");
  try {
    const script = join(f.root, "discover.mjs");
    writeFileSync(script, `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
      createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
      if(m.method==='tools/call')writeFileSync(${JSON.stringify(called)},'bad');
      const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:
        m.method==='tools/list'?{tools:[{name:'echo_text',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:{};
      console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, mcp: { servers: { probe: { transport: "stdio", command: process.execPath, args: [script] } } } }));
    const config = await f.json<any>("/config");
    const check = await f.json<any>("/checks", "POST", { revision: config.revision, kind: "mcp", agent: "raw", name: "probe" });
    const done = await checkDone(f, check.id); assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.result.tools[0].originalName, "echo_text"); assert.equal(done.result.tools[0].identity, "mcp/probe/echo_text");
    assert.equal(existsSync(called), false);
  } finally { await f.close(); }
});

test("alternate config retention validation cannot mutate the canonical file", async () => {
  const f = await dashboardFixture(); const path = join(f.root, "alternate.json"); writeFileSync(path, JSON.stringify(f.config));
  const { startDashboard } = await import("../src/dashboard/server.js");
  const server = await startDashboard({ cwd: f.root, env: f.env, configPath: path, port: 0 });
  const api = (route: string, method = "GET", body?: unknown) => fetch(server.url + "/api" + route, { method,
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const before = readFileSync(f.configPath, "utf8"), config = await (await api("/config")).json() as any;
    assert.equal(config.canonical, false); assert.equal(config.canonicalPath, f.configPath);
    const response = await api("/config", "PATCH", { revision: config.revision, patch: { sessions: { retention_days: 10 } } });
    assert.equal(response.status, 422); assert.equal(readFileSync(f.configPath, "utf8"), before);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(f.config));
  } finally { await server.close(); await f.close(); }
});
