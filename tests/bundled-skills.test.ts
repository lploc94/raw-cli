import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";

function config(skillIds: string[], maxOutputBytes = 8192) {
  const root = mkdtempSync(join(tmpdir(), "raw-builtin-skill-"));
  const configPath = join(root, "agent.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
  agents: { raw: { model: "local", max_output_bytes: maxOutputBytes,
    tools: { use: ["builtin/list_skills", "builtin/load_skill"] }, skills: { use: skillIds } } } }));
  return { root, configPath };
}

test("installed configure_raw skill is selected only and returned by linked tools", async () => {
  const { root, configPath } = config(["builtin/configure_raw"]);
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    const definitions = JSON.stringify(tools.registry.definitions());
    assert.doesNotMatch(definitions, /configure_raw|default_agent|system_prompt_file/);
    const context = { cwd: root, maxOutputBytes: runtime.maxOutputBytes, autoApprove: true };
    const catalog = await tools.registry.dispatch("list_skills", {}, context);
    assert.deepEqual((catalog.content[0] as { value: { skills: Array<{ name: string }> } }).value.skills.map((skill) => skill.name), ["configure-raw"]);
    const result = await tools.registry.dispatch("load_skill", { name: "configure-raw" }, context);
    assert.equal(result.isError, false);
    const markdown = (result.content[0] as { text: string }).text;
    for (const term of ["default_agent", "models", "agents", "system_prompt_file", "tools.use", "skills.use", "mcp.servers", "compact.trigger_tokens", "--agent", "RAW_AGENT", "validate", "resume"]) {
      assert.ok(markdown.includes(term), `missing ${term}`);
    }
    assert.match(markdown, /last matching rule wins/);
    assert.equal(markdown, parseSkillMarkdown(readFileSync(join("dist", "skills", "builtin", "configure_raw", "SKILL.md"), "utf8"), "configure_raw").markdown);
    const example = markdown.match(/```json\n([\s\S]*?)\n```/)?.[1];
    assert.ok(example);
    const examplePath = join(root, "example.json");
    writeFileSync(examplePath, JSON.stringify(JSON.parse(example)));
    const exampleRuntime = await loadConfig({ configPath: examplePath, env: {}, requireModel: true });
    assert.equal(exampleRuntime.agentName, "raw");
    assert.equal(exampleRuntime.compact.triggerTokens, 24000);
  } finally { await tools.mcp.close(); }
});

test("unselected builtin skill is inert and oversized selection fails before inference", async () => {
  const empty = config([]);
  const runtime = await loadConfig({ configPath: empty.configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: empty.root });
  try {
    const result = await tools.registry.dispatch("list_skills", {}, { cwd: empty.root, maxOutputBytes: 8192, autoApprove: true });
    assert.deepEqual((result.content[0] as { value: { skills: unknown[] } }).value.skills, []);
  } finally { await tools.mcp.close(); }
  const capped = config(["builtin/configure_raw"], 64);
  const selected = await loadConfig({ configPath: capped.configPath, env: {}, requireModel: true });
  await assert.rejects(createRuntimeTools({ runtime: selected, cwd: capped.root }), /max_output_bytes/);
});

test("the six setup skills have distinct catalog entries and complete linked bodies", async () => {
  const ids = ["configure_raw", "create_skill", "create_tool", "create_agent", "add_mcp", "create_package"];
  const { root, configPath } = config(ids.map((id) => `builtin/${id}`));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  const tools = await createRuntimeTools({ runtime, cwd: root });
  try {
    const context = { cwd: root, maxOutputBytes: runtime.maxOutputBytes, autoApprove: true };
    const catalog = await tools.registry.dispatch("list_skills", {}, context);
    const entries = (catalog.content[0] as { value: { skills: Array<{ name: string; description: string }> } }).value.skills;
    assert.deepEqual(entries.map((entry) => entry.name), ids.map((id) => id.replaceAll("_", "-")));
    assert.equal(new Set(entries.map((entry) => entry.description)).size, ids.length);
    for (const id of ids) {
      const body = await tools.registry.dispatch("load_skill", { name: id.replaceAll("_", "-") }, context);
      assert.equal(body.isError, false);
      const markdown = (body.content[0] as { text: string }).text;
      assert.equal(markdown, parseSkillMarkdown(readFileSync(join("dist", "skills", "builtin", id, "SKILL.md"), "utf8"), id).markdown);
      assert.ok(markdown.trim(), `${id} has an empty body`);
      assert.ok(Buffer.byteLength(markdown) <= 8192, `${id} exceeds the default cap`);
      assert.match(markdown, /```json\n[\s\S]*?\n```/);
    }
  } finally { await tools.mcp.close(); }
});
