import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadSelectedSkills } from "../src/skills/loader.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";

function body(id: string): string {
  return readFileSync(join("src", "skills", "bundled", id, "SKILL.md"), "utf8");
}

function fence(id: string, language: string, index: number | string = 0): string {
  if (typeof index === "string") {
    const section = body(id).split(`<!-- example:${index} -->`)[1];
    assert.ok(section, `${id} missing named example ${index}`);
    const value = section.match(new RegExp(`\\x60\\x60\\x60${language}\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`))?.[1];
    assert.ok(value, `${id}/${index} missing ${language}`);
    return value;
  }
  const matches = [...body(id).matchAll(new RegExp(`\\x60\\x60\\x60${language}\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`, "g"))];
  const value = matches[index]?.[1];
  assert.ok(value, `${id} missing ${language} example ${index}`);
  return value;
}

function model() {
  return { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" };
}

test("create_skill example registers a config-adjacent selected skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-skill-example-"));
  const skillRoot = join(root, "skills", "release-notes");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), fence("create_skill", "markdown", "body") + "\n");
  const registration = JSON.parse(fence("create_skill", "json", "registration"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "helper", models: { local: {
    provider: "openai", method: "openai-chat-completions", model_id: "fixture", api_key_env: "RAW_TEST_MISSING_KEY" } },
    agents: { helper: { model: "local", ...registration } } }));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: false });
  const selected = await loadSelectedSkills({ selectedIds: runtime.skillIds, configPath, maxOutputBytes: 8192, cwd: root });
  assert.deepEqual(selected.map((skill) => skill.name), ["release-notes"]);
  assert.match(selected[0]!.markdown, /commit hash/);
});

test("configure_raw canonical candidate validation accepts sessions and rejects invalid models without editing the source", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-config-validation-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, "raw"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(process.cwd(), "dist/raw.js"))} "$@"\n`, { mode: 0o700 });
    const script = join(root, "validate.sh");
    writeFileSync(script, fence("configure_raw", "sh", "validate-canonical"));
    const candidate = join(root, "candidate.json");
    const document = { default_agent: "raw", models: { lab: { provider: "custom", method: "openai-chat-completions", model_id: "fixture", base_url: "http://127.0.0.1:9999/v1" } }, agents: { raw: { model: "lab", tools: { use: [] } } }, sessions: { retention_days: 30 } };
    writeFileSync(candidate, JSON.stringify(document));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const good = spawnSync("bash", [script, candidate], { env, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(readFileSync(candidate, "utf8")), document);
    const invalid = structuredClone(document); invalid.models.lab.base_url = "not-a-url";
    writeFileSync(candidate, JSON.stringify(invalid));
    const bad = spawnSync("bash", [script, candidate], { env, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(candidate, "utf8")), invalid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create_tool example validates a later batch row before side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-example-"));
  const xdg = join(root, "xdg");
  const plugin = join(xdg, "raw", "tools", "append_notes");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "tool.json"), JSON.stringify(JSON.parse(fence("create_tool", "json", "manifest"))));
  writeFileSync(join(plugin, "index.mjs"), fence("create_tool", "js", "handler") + "\n");
  const registration = JSON.parse(fence("create_tool", "json", "registration"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: model() },
    agents: { raw: { model: "local", ...registration } } }));
  const runtime = await loadConfig({ configPath, env: { XDG_CONFIG_HOME: xdg }, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    const context = { cwd: root, maxOutputBytes: 8192, autoApprove: true };
    const invalid = await tools.registry.dispatch("append_notes", { operations: [
      { path: "notes.txt", text: "valid\n" }, { path: "other.txt", text: "missing newline" },
    ] }, context);
    assert.equal(invalid.isError, true);
    assert.equal(existsSync(join(root, "notes.txt")), false);
    const valid = await tools.registry.dispatch("append_notes", { operations: [
      { path: "notes.txt", text: "valid\n" },
    ] }, context);
    assert.equal(valid.isError, false);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "valid\n");
    const again = await tools.registry.dispatch("append_notes", { operations: [{ path: "notes.txt", text: "next\n" }] }, context);
    assert.equal(again.isError, false);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "valid\nnext\n");
    const unknown = await tools.registry.dispatch("append_notes", { operations: [{ path: "notes.txt", text: "bad\n", extra: true }] }, context);
    assert.equal(unknown.isError, true);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "valid\nnext\n");
  } finally { await tools.mcp.close(); }
});

test("create_agent example is a complete portable config", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-agent-example-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify(JSON.parse(fence("create_agent", "json", "config"))));
  writeFileSync(join(root, "prompt.md"), "You are a writing assistant.\n");
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  assert.equal(runtime.agentName, "writer");
  assert.equal(runtime.systemPrompt, "You are a writing assistant.\n");
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try { assert.deepEqual(tools.skills.map((skill) => skill.name), ["configure-raw"]); }
  finally { await tools.mcp.close(); }
  const moved = mkdtempSync(join(tmpdir(), "raw-copied-agent-example-"));
  cpSync(root, moved, { recursive: true });
  try {
    const copied = await loadConfig({ configPath: join(moved, "raw.json"), cwd: tmpdir(), env: {}, requireModel: false });
    assert.equal(copied.systemPrompt, runtime.systemPrompt);
    const loaded = await createRuntimeTools({ runtime: copied, cwd: tmpdir() });
    try {
      const context = { cwd: moved, maxOutputBytes: 8192, autoApprove: true };
      const safe = await loaded.registry.dispatch("bash", { commands: [{ command: "printf safe" }] }, context);
      assert.equal(safe.isError, false);
      const gated = await loaded.registry.dispatch("bash", { commands: [{ command: "rm nonexistent" }] }, context);
      assert.equal(gated.isError, true);
      assert.match(JSON.stringify(gated), /approval|ask/i);
    } finally { await loaded.mcp.close(); }
  } finally { rmSync(moved, { recursive: true, force: true }); }
});

test("add_mcp example discovers and calls one exact selected stdio tool", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-mcp-example-"));
  const script = join(root, "echo.mjs");
  writeFileSync(script, fence("add_mcp", "js", "server") + "\n");
  const document = JSON.parse(fence("add_mcp", "json", "config"));
  document.mcp.servers.echo.args = [script];
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify(document));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    const selected = tools.mcp.exposed.find((item) => item.originalName === "echo_text");
    assert.ok(selected);
    const result = await tools.registry.dispatch(selected.alias, { text: "hello" },
      { cwd: root, maxOutputBytes: 8192, autoApprove: true });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /hello/);
  } finally { await tools.mcp.close(); }
  document.agents.research.tools.use = ["builtin/read_file"];
  writeFileSync(configPath, JSON.stringify(document));
  const inactive = await createRuntimeTools({ runtime: await loadConfig({ configPath, env: {}, requireModel: true }), cwd: root });
  try { assert.equal(inactive.mcp.catalog.length, 0); }
  finally { await inactive.mcp.close(); }
});

test("add_mcp remote example is valid but header/environment values stay literal", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-mcp-remote-example-"));
  try {
    const remote = JSON.parse(fence("add_mcp", "json", "remote-server"));
    remote.headers.Authorization = "Bearer ${RAW_MCP_TOKEN}";
    const configPath = join(root, "raw.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: model() }, agents: { raw: { model: "local", tools: { use: [] } } },
      mcp: { servers: { remote, local: { transport: "stdio", command: "node", env: { TOKEN: "${RAW_MCP_TOKEN}" } } } } }));
    const runtime = await loadConfig({ configPath, env: { RAW_MCP_TOKEN: "resolved-value" }, requireModel: false });
    assert.deepEqual(runtime.availableMcpServers.remote, remote);
    const local = runtime.availableMcpServers.local;
    assert.ok(local && "command" in local);
    assert.equal(local.env?.TOKEN, "${RAW_MCP_TOKEN}");
    assert.deepEqual(Object.keys(runtime.mcpServers), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
