import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { openSessionStore } from "../src/sessions/store.js";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { resumeSession } from "../src/sessions/api.js";
import type { ProviderRequest } from "../src/llm/types.js";
import { createAcpServer } from "../src/acp/methods.js";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
function call(name: string, args: unknown, id: string) { return { frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] }; }
const answer = { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] };
async function raw(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [resolve("dist/raw.js"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const code = await new Promise<number | null>(resolve => child.on("close", resolve)); return { code, stdout, stderr };
}
function config(url: string) { return { default_agent: "raw", models: { m: { provider: "openai", method: "openai-chat-completions", model_id: "test", base_url: url } },
  vars: { live: { description: "live", access: "read", cache_ttl_ms: 60000, source: { kind: "file", path: "live.txt" } }, token: { description: "credential", access: "use", source: { kind: "env", name: "RAW_TEST_TOKEN" } } },
  agents: { raw: { model: "m", system_prompt: "Stable prompt", tools: { use: ["builtin/list_vars", "builtin/read_var", "builtin/bash"] }, vars: ["live", "token"] } } }; }
test("real CLI resume reads current values while retaining prefix, key, history and reference arguments; SDK resumes same session", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-vars-session-")); const path = join(root, "config.json");
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), OPENAI_API_KEY: "fixture", RAW_TEST_TOKEN: "unique-use-value-48271" };
  const provider = await startMockProvider([call("list_vars", {}, "list"), call("read_var", { name: "live" }, "read"), call("bash", { commands: [{ command: 'printf %s "$TOKEN" > received', env_refs: { TOKEN: "token" } }] }, "bind"), answer,
    call("read_var", { name: "live" }, "read2"), answer]);
  try {
    const doc = config(provider.url); writeFileSync(path, JSON.stringify(doc)); writeFileSync(join(root, "live.txt"), "before");
    const first = await raw(["--config", path, "first"], root, env); assert.equal(first.code, 0, first.stderr);
    assert.equal(readFileSync(join(root, "received"), "utf8"), env.RAW_TEST_TOKEN);
    const store = openSessionStore({ env }); const id = store.listSessions({ cwd: root }).items[0]!.id; store.close();
    writeFileSync(join(root, "live.txt"), "after"); doc.vars.live.description = "current metadata"; writeFileSync(path, JSON.stringify(doc));
    const second = await raw(["--resume", id, "second"], root, env); assert.equal(second.code, 0, second.stderr);
    const bodies = provider.requests.map(r => r.body as { messages: unknown[]; tools: unknown; prompt_cache_key: string });
    assert.deepEqual(bodies[0]!.tools, bodies[4]!.tools); assert.deepEqual(bodies[0]!.messages[0], bodies[4]!.messages[0]);
    assert.equal(bodies[0]!.prompt_cache_key, bodies[4]!.prompt_cache_key);
    assert.match(JSON.stringify(bodies[5]!.messages), /before/); assert.match(JSON.stringify(bodies[5]!.messages), /after/);
    assert.doesNotMatch(JSON.stringify(bodies), /unique-use-value-48271/);
    const inspect = openSessionStore({ env });
    try { const history = JSON.stringify(inspect.getSessionHistory({ sessionId: id })); assert.match(history, /env_refs/); assert.doesNotMatch(history, /unique-use-value-48271/); }
    finally { inspect.close(); }
    const runtime = await loadConfig({ configPath: path, env }); const tools = await createRuntimeTools({ runtime, cwd: root, env });
    const requests: ProviderRequest[] = [];
    const resumed = resumeSession({ sessionId: id, storeOptions: { env }, agentOptions: { provider: { modelConfig: runtime.modelConfig!, generate: async request => {
      requests.push(request); return { text: "sdk", toolCalls: [], finishReason: "stop" }; } },
      registry: tools.registry, whitelist: tools.selectedNames, toolSourceDigest: tools.toolSourceDigest, selectedSkills: tools.skills,
      cwd: root, system: runtime.systemPrompt } });
    try { assert.equal((await resumed.agent.run("SDK continuation")).status, "completed"); assert.match(JSON.stringify(requests[0]!.messages), /after/); }
    finally { await resumed.close(); await tools.mcp.close(); }
  } finally { await provider.close(); }
});
test("ACP uses the same selected variable tools and appends values as tool results", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-vars-acp-")); const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config("http://localhost:1"))); writeFileSync(join(root, "live.txt"), "acp-value");
  const runtime = await loadConfig({ configPath: path, env: { OPENAI_API_KEY: "fixture" } }); const requests: ProviderRequest[] = [];
  const server = createAcpServer({ runtime, storeOptions: { env: { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root } }, providerFactory: () => ({ modelConfig: runtime.modelConfig!, generate: async request => {
    requests.push(request);
    return requests.length === 1 ? { text: "", toolCalls: [{ id: "read", name: "read_var", arguments: { name: "live" } }], finishReason: "tool_calls" } : { text: "done", toolCalls: [], finishReason: "stop" };
  } }) });
  const connection = client({ name: "vars-test" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
    await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read" }] });
    assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1]!.messages), /acp-value/);
    assert.doesNotMatch(JSON.stringify(requests[0]!.tools), /acp-value|credential/);
  } finally { connection.close(); await server.close(); }
});

test("ACP cancellation reaches an active variable provider and stops further inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-vars-acp-cancel-")); const path = join(root, "raw.json"); const marker = join(root,"started");
  const script = join(root,"wait.mjs"); writeFileSync(script,`import {writeFileSync} from 'node:fs';for await(const x of process.stdin){};writeFileSync(${JSON.stringify(marker)},'yes');process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
  const doc = { ...config("http://localhost:1"), var_providers: { wait: { command:process.execPath,args:[script] } } };
  Object.assign(doc.vars.live,{source:{kind:"provider",name:"wait"}}); writeFileSync(path,JSON.stringify(doc));
  const runtime=await loadConfig({configPath:path,env:{OPENAI_API_KEY:"fixture"}}); let calls=0;
  const server=createAcpServer({runtime,storeOptions:{env:{XDG_CONFIG_HOME:root,XDG_STATE_HOME:root}},providerFactory:()=>({modelConfig:runtime.modelConfig!,generate:async()=>{
    calls++; return {text:"",toolCalls:[{id:"read",name:"read_var",arguments:{name:"live"}}],finishReason:"tool_calls"};
  }})});
  const connection=client({name:"vars-cancel"}).connect(server.app);
  try {
    await connection.agent.request("initialize",{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{}});
    const {sessionId}=await connection.agent.request("session/new",{cwd:root,mcpServers:[]});
    const pending=connection.agent.request("session/prompt",{sessionId,prompt:[{type:"text",text:"read"}]});
    const deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(existsSync(marker));await connection.agent.notify("session/cancel",{sessionId});
    assert.equal((await pending).stopReason,"cancelled");assert.equal(calls,1);
  } finally {connection.close();await server.close();}
});
