import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { createAcpServer } from "../src/acp/methods.js";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raw-skills-"));
  const configPath = join(root, "raw.json");
  const skill = async (id: string, name: string, body: string) => {
    const folder = join(root, "skills", id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "skill.json"), JSON.stringify({ api_version: 1, id, version: "1.0.0", name,
      description: `Use ${name}` }));
    await writeFile(join(folder, "SKILL.md"), body);
  };
  const config = async (skills: string[], tools = ["builtin/list_skills", "builtin/load_skill"], extra: Record<string, unknown> = {}) => {
    await writeFile(configPath, JSON.stringify({ default_profile: "p", models: { m: {
      provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    profiles: { p: { model: "m", tools: { use: tools }, skills: { use: skills }, ...extra } } }));
    return loadConfig({ configPath, env: {}, requireModel: true });
  };
  return { root, configPath, skill, config };
}

test("selected skills appear only through bundled list and load results", async () => {
  const { root, skill, config } = await fixture();
  await skill("review", "review", "PRIVATE_SKILL_SENTINEL\n");
  const runtime = await config(["agent/review"]);
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    assert.deepEqual(tools.selectedNames, ["list_skills", "load_skill"]);
    assert.doesNotMatch(JSON.stringify(tools.registry.definitions()), /review|PRIVATE_SKILL_SENTINEL/);
    const context = { cwd: root, maxOutputBytes: runtime.maxOutputBytes, autoApprove: true };
    const list = await tools.registry.dispatch("list_skills", {}, context);
    assert.deepEqual(list.content, [{ type: "json", value: { skills: [{ name: "review", description: "Use review" }] } }]);
    const loaded = await tools.registry.dispatch("load_skill", { name: "review" }, context);
    assert.deepEqual(loaded.content, [{ type: "text", text: "PRIVATE_SKILL_SENTINEL\n" }]);
  } finally { await tools.mcp.close(); }
});

test("skills require both explicit tools, and selected-only discovery validates names, paths and bytes", async () => {
  const { root, configPath, skill, config } = await fixture();
  await skill("one", "same", "one\n");
  await skill("two", "same", "two\n");
  await assert.rejects(config(["agent/one"], ["builtin/list_skills"]), /requires builtin\/list_skills and builtin\/load_skill/);
  await assert.rejects(config(["agent/one", "agent/one"]), /duplicate IDs/);
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/missing"]), cwd: root }), /missing selected skill/);
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/one", "agent/two"]), cwd: root }), /duplicate skill name/);
  await writeFile(join(root, "skills", "two", "skill.json"), "{broken");
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/two"]), cwd: root }), /invalid skill manifest JSON/);
  const selected = await createRuntimeTools({ runtime: await config(["agent/one"]), cwd: root });
  try { assert.deepEqual(selected.skills.map((item) => item.name), ["same"]); }
  finally { await selected.mcp.close(); }
  await writeFile(join(root, "skills", "one", "SKILL.md"), Buffer.from([0xff]));
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/one"]), cwd: root }), /invalid UTF-8/);
  const outside = join(root, "outside.md");
  await writeFile(outside, "outside");
  await unlink(join(root, "skills", "one", "SKILL.md"));
  await symlink(outside, join(root, "skills", "one", "SKILL.md"));
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/one"]), cwd: root }), /escapes folder/);
  await unlink(join(root, "skills", "one", "SKILL.md"));
  await writeFile(join(root, "skills", "one", "SKILL.md"), "inside");
  await assert.rejects(createRuntimeTools({ runtime: await config(["agent/one"], undefined,
    { max_output_bytes: 20 }), cwd: root }), /catalog exceeds max_output_bytes/);
  await writeFile(join(root, "skills", "one", "skill.json"), JSON.stringify({ api_version: 1, id: "one", version: "1.0.0", name: "same", description: "Same" }));
  const empty = await createRuntimeTools({ runtime: await config([], []), cwd: root });
  try { assert.deepEqual(empty.selectedNames, []); }
  finally { await empty.mcp.close(); }
  await writeFile(configPath, JSON.stringify({ default_profile: "p", models: { m: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
  profiles: { p: { model: "m", tools: { use: ["builtin/list_skills", "builtin/load_skill"] },
    skills: { use: ["agent/one"] }, max_output_bytes: 4 } } }));
  await assert.rejects(createRuntimeTools({ runtime: await loadConfig({ configPath, env: {} }), cwd: root }), /max_output_bytes/);
});

test("denied, cancelled and unknown loads never reveal selected Markdown", async () => {
  const { root, skill, config } = await fixture();
  await skill("private", "private", "PRIVATE_BODY_SENTINEL");
  const runtime = await config(["agent/private"], ["builtin/list_skills", "builtin/load_skill"],
    { tools: { use: ["builtin/list_skills", "builtin/load_skill"], rules: [{ match: "builtin/load_skill", effect: "deny" }] } });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    const context = { cwd: root, maxOutputBytes: runtime.maxOutputBytes, autoApprove: true };
    const denied = await tools.registry.dispatch("load_skill", { name: "private" }, context);
    assert.equal(denied.code, "tool_denied");
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_BODY_SENTINEL/);
  } finally { await tools.mcp.close(); }
  const allowedRuntime = await config(["agent/private"]);
  const allowed = await createRuntimeTools({ runtime: allowedRuntime, cwd: root });
  try {
    const controller = new AbortController(); controller.abort();
    const context = { cwd: root, maxOutputBytes: allowedRuntime.maxOutputBytes, autoApprove: true };
    const cancelled = await allowed.registry.dispatch("load_skill", { name: "private" }, { ...context, signal: controller.signal });
    const unknown = await allowed.registry.dispatch("load_skill", { name: "absent" }, context);
    assert.equal(cancelled.code, "aborted");
    assert.equal(unknown.code, "unknown_skill");
    assert.doesNotMatch(JSON.stringify([cancelled, unknown]), /PRIVATE_BODY_SENTINEL/);
  } finally { await allowed.mcp.close(); }
});

test("global skill root follows the config environment and ignores unselected invalid folders", async () => {
  const { root, configPath } = await fixture();
  const global = join(root, "global");
  const selectedFolder = join(global, "raw", "skills", "global");
  const invalidFolder = join(root, "skills", "unselected");
  await mkdir(selectedFolder, { recursive: true });
  await mkdir(invalidFolder, { recursive: true });
  await writeFile(join(selectedFolder, "skill.json"), JSON.stringify({ api_version: 1, id: "global", version: "1.0.0",
    name: "global", description: "Global instructions" }));
  await writeFile(join(selectedFolder, "SKILL.md"), "Global body\n");
  await writeFile(join(invalidFolder, "skill.json"), "not JSON");
  await writeFile(configPath, JSON.stringify({ default_profile: "p", models: { m: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } }, profiles: { p: {
      model: "m", tools: { use: ["builtin/list_skills", "builtin/load_skill"] },
      skills: { use: ["local/global"] },
    } } }));
  const runtime = await loadConfig({ configPath, env: { XDG_CONFIG_HOME: global }, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try { assert.deepEqual(tools.skills.map((skill) => skill.markdown), ["Global body\n"]); }
  finally { await tools.mcp.close(); }
});

test("ACP provider sees skill metadata and Markdown only after linked tool calls", async () => {
  const { root, skill, config } = await fixture();
  await skill("acp", "acp_skill", "ACP_MARKDOWN_SENTINEL\n");
  const runtime = await config(["agent/acp"]);
  const requests: Array<{ system: string; tools: unknown; messages: unknown }> = [];
  const server = createAcpServer({ runtime, storeOptions: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "xdg") } },
    providerFactory: () => ({ profile: runtime.profile!, async generate(request) {
      requests.push({ system: request.system, tools: structuredClone(request.tools), messages: structuredClone(request.messages) });
      if (requests.length === 1) return { text: "", toolCalls: [{ id: "list", name: "list_skills", arguments: {} }], finishReason: "tool_calls" };
      if (requests.length === 2) return { text: "", toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "acp_skill" } }], finishReason: "tool_calls" };
      return { text: "done", toolCalls: [], finishReason: "stop" };
    } }) });
  const connection = client({ name: "skill-test" }).connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd: root, mcpServers: [] });
    assert.equal((await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "use skill" }] })).stopReason, "end_turn");
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests[0]), /acp_skill|ACP_MARKDOWN_SENTINEL/);
    assert.match(JSON.stringify(requests[1]), /acp_skill/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /ACP_MARKDOWN_SENTINEL/);
    assert.match(JSON.stringify(requests[2]), /ACP_MARKDOWN_SENTINEL/);
    const messages = requests[2]!.messages as Array<{ role: string; callId?: string }>;
    assert.deepEqual(messages.filter((item) => item.role === "tool").map((item) => item.callId), ["list", "load"]);
  } finally { connection.close(); await server.close(); }
});

test("CLI appends list and load results after linked calls and keeps loaded Markdown on resume", async () => {
  const { root, configPath, skill } = await fixture();
  const body = "PRIVATE_MARKDOWN_ONLY_AFTER_LOAD\n";
  await skill("alpha", "alpha", body);
  await skill("beta", "beta", "Second skill\n");
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "list", type: "function", function: { name: "list_skills", arguments: "{}" } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "load", type: "function", function: { name: "load_skill", arguments: '{"name":"alpha"}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "resumed" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "reloaded" }, "stop"), openAiDone] },
  ]);
  try {
    await writeFile(configPath, JSON.stringify({ default_profile: "p", models: { m: {
      provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: provider.url,
    } }, profiles: { p: { model: "m", tools: { use: ["builtin/list_skills", "builtin/load_skill"] },
      skills: { use: ["agent/alpha", "agent/beta"] }, system_prompt: "Skill agent" } } }));
    const env = { ...process.env, OPENAI_API_KEY: "fixture", XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "xdg") };
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
        "--config", configPath, ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(); child.stdout.resume();
      let stderr = ""; child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      assert.equal(code, 0, stderr);
      return stderr;
    };
    const first = await run(["first"]);
    const id = first.match(/raw --resume ([0-9a-f-]{36})/)?.[1];
    assert.ok(id);
    const requests = provider.requests.map((item) => item.body as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> });
    assert.doesNotMatch(JSON.stringify(requests[0]), /alpha|beta|PRIVATE_MARKDOWN_ONLY_AFTER_LOAD/);
    assert.match(JSON.stringify(requests[1]), /alpha|beta/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /PRIVATE_MARKDOWN_ONLY_AFTER_LOAD/);
    assert.match(JSON.stringify(requests[2]), /PRIVATE_MARKDOWN_ONLY_AFTER_LOAD/);
    assert.deepEqual(requests[2]!.messages.filter((item) => item.role === "tool").map((item) => item.tool_call_id), ["list", "load"]);
    await run(["--resume", id, "again"]);
    assert.match(JSON.stringify(provider.requests[3]?.body), /PRIVATE_MARKDOWN_ONLY_AFTER_LOAD/);
    assert.doesNotMatch(JSON.stringify(provider.requests[3]?.body), /reload notice/);
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "UPDATED_MARKDOWN_AFTER_RESUME\n");
    await run(["--resume", id, "after edit"]);
    const originalBody = provider.requests[0]?.body as { prompt_cache_key: string };
    const editedBody = provider.requests[4]?.body as { prompt_cache_key: string; messages: unknown[] };
    assert.equal(editedBody.prompt_cache_key, originalBody.prompt_cache_key);
    assert.match(JSON.stringify(editedBody.messages), /PRIVATE_MARKDOWN_ONLY_AFTER_LOAD/);
    assert.match(JSON.stringify(editedBody.messages), /reload notice.*alpha/);
    assert.equal((JSON.stringify(editedBody.messages).match(/reload notice/g) ?? []).length, 1);
  } finally { await provider.close(); }
});
