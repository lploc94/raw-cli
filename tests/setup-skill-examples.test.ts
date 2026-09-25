import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadSelectedSkills } from "../src/skills/loader.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";

function body(id: string): string {
  return readFileSync(join("src", "skills", "bundled", id, "SKILL.md"), "utf8");
}

function fence(id: string, language: string, index = 0): string {
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
  const skillRoot = join(root, "skills", "release_notes");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "skill.json"), JSON.stringify(JSON.parse(fence("create_skill", "json"))));
  writeFileSync(join(skillRoot, "SKILL.md"), fence("create_skill", "markdown") + "\n");
  const registration = JSON.parse(fence("create_skill", "json", 1));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "helper", models: { local: model() },
    agents: { helper: { model: "local", ...registration } } }));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const selected = await loadSelectedSkills({ selectedIds: runtime.skillIds, configPath, maxOutputBytes: 8192, cwd: root });
  assert.deepEqual(selected.map((skill) => skill.name), ["release_notes"]);
  assert.match(selected[0]!.markdown, /commit hash/);
});

test("create_tool example validates a later batch row before side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-example-"));
  const xdg = join(root, "xdg");
  const plugin = join(xdg, "raw", "tools", "append_notes");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "tool.json"), JSON.stringify(JSON.parse(fence("create_tool", "json"))));
  writeFileSync(join(plugin, "index.mjs"), fence("create_tool", "js") + "\n");
  const registration = JSON.parse(fence("create_tool", "json", 1));
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
  } finally { await tools.mcp.close(); }
});

test("create_agent example is a complete portable config", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-agent-example-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify(JSON.parse(fence("create_agent", "json"))));
  writeFileSync(join(root, "prompt.md"), "You are a writing assistant.\n");
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  assert.equal(runtime.agentName, "writer");
  assert.equal(runtime.systemPrompt, "You are a writing assistant.\n");
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try { assert.deepEqual(tools.skills.map((skill) => skill.name), ["configure_raw"]); }
  finally { await tools.mcp.close(); }
});

test("add_mcp example discovers and calls one exact selected stdio tool", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-mcp-example-"));
  const script = join(root, "echo.mjs");
  writeFileSync(script, fence("add_mcp", "js") + "\n");
  const document = JSON.parse(fence("add_mcp", "json"));
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
