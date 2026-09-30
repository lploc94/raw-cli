import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportAgentPackage, inspectPackage } from "../src/packages/export.js";

test("export requirements include selected builtin effects and panels without copying tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-export-builtins-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { a: { model: "m", tools: { use: ["builtin/write_file", "builtin/todo"] } } } }));
  const out = join(root, "export");
  const result = await exportAgentPackage({ configPath, agentName: "a", out, name: "@example/builtins", version: "1.0.0" });
  assert.ok(result.report.requires.includes("raw.tool-effects/1"));
  assert.ok(result.report.requires.includes("raw.panel/2"));
  assert.equal(existsSync(join(out, "tools")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "agents", "a.json"), "utf8")).tools.use, ["builtin/write_file", "builtin/todo"]);
});

test("mixed agent export copies declared owned assets without credentials, runtime readings or execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-export-author-"));
  const configPath = join(root, "raw.json");
  const tool = join(root, "tools", "helper");
  const skill = join(root, "skills", "review");
  mkdirSync(tool, { recursive: true }); mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(root, "prompt.md"), "You are a reviewer.\n");
  writeFileSync(join(tool, "tool.json"), JSON.stringify({ api_version: 2, id: "helper", version: "1.0.0",
    name: "helper", description: "Helper", input_schema: { type: "object" }, entry: "./index.mjs" }));
  writeFileSync(join(tool, "index.mjs"), 'import "./linked.mjs"; export async function handler() { return {content: []}; }');
  writeFileSync(join(tool, "helper.mjs"), 'throw new Error("export executed tool");');
  symlinkSync(join(tool, "helper.mjs"), join(tool, "linked.mjs"));
  writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review a change\n---\n# Review\nSee references/check.md\n");
  writeFileSync(join(skill, "references", "check.md"), "Checklist\n");
  writeFileSync(join(root, "provider.mjs"), 'throw new Error("export executed provider");');
  writeFileSync(join(root, "mcp-server.mjs"), 'throw new Error("export started MCP");');
  writeFileSync(configPath, JSON.stringify({ default_agent: "author", models: { local: {
    provider: "openai", method: "openai-chat-completions", model_id: "secret-model", api_key: "AUTHOR_CREDENTIAL_SENTINEL" } },
  vars: { token: { description: "Token", access: "use", source: { kind: "env", name: "AUTHOR_TOKEN" } },
    host: { description: "Host data", access: "read", source: { kind: "provider", name: "host", params: { private: "AUTHOR_PARAM" } } } },
  var_providers: { host: { command: "node", args: ["./provider.mjs"] } },
  mcp: { servers: { search: { transport: "stdio", command: "node", args: ["./mcp-server.mjs"], env: { TOKEN: "AUTHOR_MCP_SECRET" } } } },
  agents: { author: { model: "local", system_prompt_file: "prompt.md", tools: { use: ["agent/helper", "builtin/list_skills", "builtin/load_skill", "mcp/search/find"],
    rules: [{ match: "agent/helper", effect: "ask" }] },
    skills: { use: ["agent/review"] }, vars: ["token", "host"] } } }));
  const output = mkdtempSync(join(tmpdir(), "raw-export-output-"));
  const result = await exportAgentPackage({ configPath, agentName: "author", out: output,
    name: "@example/reviewer", version: "1.0.0" });
  assert.equal(result.report.agent, "author");
  assert.ok(existsSync(join(output, "tools", "helper", "helper.mjs")));
  assert.ok(lstatSync(join(output, "tools", "helper", "linked.mjs")).isFile());
  assert.ok(existsSync(join(output, "skills", "review", "references", "check.md")));
  assert.ok(existsSync(join(output, "prompts", "author.md")));
  const exportedAgent = JSON.parse(readFileSync(join(output, "agents", "author.json"), "utf8"));
  assert.deepEqual(exportedAgent.tools.rules, [{ match: "@example/reviewer#tools/helper", effect: "ask" }]);
  assert.equal(existsSync(join(output, "provider.mjs")), false);
  assert.equal(existsSync(join(output, "mcp-server.mjs")), false);
  const manifest = readFileSync(join(output, "raw-package.json"), "utf8");
  assert.doesNotMatch(manifest, /AUTHOR_CREDENTIAL_SENTINEL|secret-model|AUTHOR_TOKEN|AUTHOR_PARAM|AUTHOR_MCP_SECRET/);
  renameSync(root, `${root}.hidden`);
  const inspected = await inspectPackage(output);
  assert.equal(inspected.name, "@example/reviewer");
  assert.ok(inspected.exports.tools.includes("helper"));
  assert.ok(inspected.exports.mcp.includes("search"));
  assert.ok(inspected.exports.var_providers.includes("host"));
  assert.ok(inspected.inputs.includes("mcp_search_arg_0"));
  assert.ok(inspected.prerequisites.includes("node"));
});

test("explicit author include choices carry file and literal assets, while default export requires bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-export-literals-"));
  const configPath = join(root, "raw.json");
  writeFileSync(join(root, "data.txt"), "AUTHORED_DATA\n");
  writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: { m: { provider: "ollama",
    method: "openai-chat-completions", model_id: "fixture" } },
  vars: { data: { description: "Data", access: "read", source: { kind: "file", path: "data.txt" } },
    count: { description: "Count", access: "read", source: { kind: "literal", value: 42 } } },
  agents: { a: { model: "m", tools: { use: [] }, vars: ["data", "count"] } } }));
  const draft = mkdtempSync(join(tmpdir(), "raw-export-bindings-"));
  const withAssets = mkdtempSync(join(tmpdir(), "raw-export-assets-"));
  const base = { configPath, agentName: "a", name: "@example/data", version: "1.0.0" };
  const first = await exportAgentPackage({ ...base, out: draft });
  assert.deepEqual([...first.report.inputs].sort(), ["var_count_source", "var_data_file"]);
  const second = await exportAgentPackage({ ...base, out: withAssets, includeFiles: ["data.txt"], includeLiterals: true });
  assert.deepEqual(second.report.inputs, []);
  assert.equal(readFileSync(join(withAssets, "assets", "vars", "data-data.txt"), "utf8"), "AUTHORED_DATA\n");
  assert.match(readFileSync(join(withAssets, "vars", "count.json"), "utf8"), /42/);
});

test("draft export reports missing selected assets without creating a distributable", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-export-draft-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: { m: { provider: "ollama",
    method: "openai-chat-completions", model_id: "fixture" } },
  agents: { a: { model: "m", tools: { use: ["agent/missing"] } } } }));
  const out = join(root, "export");
  const options = { configPath, agentName: "a", out, name: "@example/draft", version: "1.0.0" };
  const draft = await exportAgentPackage({ ...options, draft: true });
  assert.match(draft.report.unresolved.join("\n"), /selected tool agent\/missing/);
  assert.equal(existsSync(join(out, "raw-package.json")), false);
  await assert.rejects(exportAgentPackage(options), /unresolved export assets.*agent\/missing/s);
  const outside = mkdtempSync(join(tmpdir(), "raw-export-outside-"));
  mkdirSync(join(root, "tools"));
  symlinkSync(outside, join(root, "tools", "missing"), "dir");
  const escaped = await exportAgentPackage({ ...options, draft: true });
  assert.match(escaped.report.unresolved.join("\n"), /escapes its owned root/);
});
