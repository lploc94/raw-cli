import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { installPackage, updatePackage } from "../src/packages/store.js";
import { packPackage } from "../src/packages/archive.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { createVariableResolver } from "../src/vars/resolver.js";
import { exportAgentPackage } from "../src/packages/export.js";
import { addPackageAgent } from "../src/packages/cli.js";

function fixture(prompt: string) {
  const root = mkdtempSync(join(tmpdir(), "raw-package-config-"));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "writer.json"), JSON.stringify({ system_prompt: prompt,
    tools: { use: ["builtin/read_file"] } }));
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/writer", version: "1.0.0",
    description: "Writer", files: ["agents/writer.json"], exports: { agents: { writer: "agents/writer.json" } } }));
  return root;
}

test("installed agent adopts current package prompt while retaining recipient model and binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-runtime-"));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: { local: {
    provider: "ollama", method: "openai-chat-completions", model_id: "test", base_url: "http://127.0.0.1:1/v1",
  } }, agents: { writer: { from: "pkg/kit/agents/writer", model: "local", overrides: { max_steps: 3 } } } }));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    await installPackage({ configPath, dataHome, source: fixture("first"), alias: "kit" });
    const before = await loadConfig({ configPath, requireModel: false });
    assert.equal(before.systemPrompt, "first");
    assert.equal(before.modelConfig?.modelAlias, "local");
    assert.equal(before.maxSteps, 3);
    assert.deepEqual(before.toolIds, ["builtin/read_file"]);
    await updatePackage({ configPath, dataHome, source: fixture("second"), alias: "kit" });
    const after = await loadConfig({ configPath, requireModel: false });
    assert.equal(after.systemPrompt, "second");
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).agents.writer.overrides, { max_steps: 3 });
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("a direct agent selects an installed tool under an explicit visible alias and canonical policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-tool-"));
  const source = join(root, "source");
  const folder = join(source, "tools", "echo"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "echo", version: "1.0.0",
    name: "echo", description: "Echo a word", input_schema: { type: "object",
      properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false }, entry: "./index.mjs" }));
  writeFileSync(join(folder, "index.mjs"), "export async function handler(args){return {content:[{type:'text',text:args.word}]}}\n");
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/echo", version: "1.0.0",
    description: "Echo", files: ["tools/echo"], exports: { tools: { public: "tools/echo" } } }));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { raw: { model: "local",
    tools: { use: [{ ref: "pkg/kit/tools/public", as: "say" }],
      rules: [{ match: "@test/echo#tools/public", effect: "deny" }] } } } }));
  await installPackage({ configPath, dataHome, source, alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const config = await loadConfig({ configPath, requireModel: false });
    const runtime = await createRuntimeTools({ runtime: config, cwd: root });
    try {
      assert.deepEqual(runtime.selectedNames, ["say"]);
      assert.equal(runtime.registry.canonicalIdentity("say"), "@test/echo#tools/public");
      assert.deepEqual(runtime.registry.definitions(runtime.selectedNames), []);
    } finally { await runtime.mcp.close(); }
    await installPackage({ configPath, dataHome, source, alias: "other" });
    const updated = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { raw: { tools: { use: Array<{ ref: string }> } } } };
    updated.agents.raw.tools.use[0]!.ref = "pkg/other/tools/public";
    writeFileSync(configPath, JSON.stringify(updated));
    const same = await createRuntimeTools({ runtime: await loadConfig({ configPath, requireModel: false }), cwd: root });
    try { assert.equal(same.toolSourceDigest, runtime.toolSourceDigest); }
    finally { await same.mcp.close(); }
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("standalone variable and MCP bindings use recipient inputs and local aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-bindings-"));
  const source = join(root, "source");
  mkdirSync(join(source, "vars"), { recursive: true }); mkdirSync(join(source, "mcp"));
  writeFileSync(join(source, "vars", "host.json"), JSON.stringify({ description: "Host", access: "read",
    source: { kind: "env", name: { $input: "env_name" } } }));
  writeFileSync(join(source, "mcp", "search.json"), JSON.stringify({ transport: "streamable-http",
    url: { $input: "endpoint" } }));
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/bindings",
    version: "1.0.0", description: "Bindings", files: ["vars/host.json", "mcp/search.json"],
    exports: { vars: { host: "vars/host.json" }, mcp: { search: "mcp/search.json" } },
    inputs: { type: "object", properties: { env_name: { type: "string", "x-raw-kind": "env-name" },
      endpoint: { type: "string" } }, required: ["env_name", "endpoint"] } }));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } },
  vars: { machine: { from: "pkg/kit/vars/host", inputs: { env_name: "RAW_FIXTURE_HOST" } } },
  mcp: { servers: { web: { from: "pkg/kit/mcp/search", inputs: { endpoint: "http://127.0.0.1:9999/mcp" } } } },
  agents: { raw: { model: "local", vars: ["machine"], tools: { use: ["mcp/web/query"],
    rules: [{ match: "mcp/web/query", effect: "deny" }] } } } }));
  await installPackage({ configPath, dataHome, source, alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const config = await loadConfig({ configPath, requireModel: false });
    assert.equal((config.availableMcpServers.web as { transport?: string }).transport, "streamable-http");
    assert.equal((config.availableMcpServers.web as { url?: string }).url, "http://127.0.0.1:9999/mcp");
    assert.equal(config.packageMcpIdentities.web, "@test/bindings#mcp/search");
    assert.equal(config.toolRules[0]?.match, "@test/bindings#mcp/search/query");
    assert.deepEqual(config.variableConfig.variables.map((item) => item.name), ["machine"]);
    const reading = await createVariableResolver({ config: config.variableConfig, env: { RAW_FIXTURE_HOST: "test-host" } }).read("machine");
    assert.equal(reading.value, "test-host");
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("standalone skill loads from installed files under its selected alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-skill-"));
  const source = join(root, "source"), folder = join(source, "skills", "review");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nCheck behavior.\n");
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/skill",
    version: "1.0.0", description: "Skill", files: ["skills/review"],
    exports: { skills: { review: "skills/review" } } }));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { raw: { model: "local",
    tools: { use: ["builtin/list_skills", "builtin/load_skill"] },
    skills: { use: [{ ref: "pkg/kit/skills/review", as: "review-kit" }] } } } }));
  await installPackage({ configPath, dataHome, source, alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const config = await loadConfig({ configPath, requireModel: false });
    const runtime = await createRuntimeTools({ runtime: config, cwd: root });
    try {
      assert.equal(runtime.skills[0]?.name, "review-kit");
      assert.match(runtime.skills[0]?.markdown ?? "", /Check behavior/);
    } finally { await runtime.mcp.close(); }
    await installPackage({ configPath, dataHome, source, alias: "other" });
    const updated = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { raw: { skills: { use: Array<{ ref: string }> } } } };
    updated.agents.raw.skills.use[0]!.ref = "pkg/other/skills/review";
    writeFileSync(configPath, JSON.stringify(updated));
    const same = await createRuntimeTools({ runtime: await loadConfig({ configPath, requireModel: false }), cwd: root });
    try { assert.equal(same.skills[0]?.id, runtime.skills[0]?.id); }
    finally { await same.mcp.close(); }
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("an agent resolves its exact dependency tool without a separate installed alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-dep-runtime-"));
  const child = join(root, "child"), folder = join(child, "tools", "echo");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "echo", version: "1.0.0",
    name: "echo", description: "Echo", input_schema: { type: "object", properties: {}, additionalProperties: false }, entry: "./index.mjs" }));
  writeFileSync(join(folder, "index.mjs"), "export async function handler(){return {content:[{type:'text',text:'from child'}]}}\n");
  writeFileSync(join(child, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/child", version: "1.0.0",
    description: "Child", files: ["tools/echo"], exports: { tools: { echo: "tools/echo" } } }));
  const archive = join(root, "child.rawpkg"), packed = await packPackage(child, archive);
  const parent = join(root, "parent"); mkdirSync(join(parent, "deps"), { recursive: true }); mkdirSync(join(parent, "agents"));
  writeFileSync(join(parent, "deps", "child.rawpkg"), readFileSync(archive));
  writeFileSync(join(parent, "agents", "writer.json"), JSON.stringify({ tools: { use: ["dep:child#tools/echo"] } }));
  writeFileSync(join(parent, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/parent", version: "1.0.0",
    description: "Parent", files: ["agents/writer.json", "deps/child.rawpkg"],
    exports: { agents: { writer: "agents/writer.json" } },
    dependencies: { child: { name: "@test/child", version: "1.0.0", digest: packed.sha256,
      archive: "deps/child.rawpkg" } } }));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { writer: {
    from: "pkg/parent/agents/writer", model: "local" } } }));
  await installPackage({ configPath, dataHome, source: parent, alias: "parent" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const config = await loadConfig({ configPath, requireModel: false });
    const runtime = await createRuntimeTools({ runtime: config, cwd: root });
    try {
      assert.deepEqual(runtime.selectedNames, ["echo"]);
      assert.equal(runtime.registry.canonicalIdentity("echo"), "@test/child#tools/echo");
    } finally { await runtime.mcp.close(); }
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("package export can re-author a selected installed agent without importing handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-reexport-"));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } },
    agents: { writer: { from: "pkg/kit/agents/writer", model: "local" } } }));
  await installPackage({ configPath, dataHome, source: fixture("reexported"), alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const out = join(root, "out");
    const result = await exportAgentPackage({ configPath, agentName: "writer", out,
      name: "@recipient/writer", version: "1.0.0" });
    assert.equal(result.report.agent, "writer");
    assert.match(readFileSync(join(out, "agents", "writer.json"), "utf8"), /reexported/);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("missing exports in unselected package bindings do not block an unrelated agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-unselected-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "good", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } },
    vars: { unused: { from: "pkg/missing/vars/x" } },
    var_providers: { unused: { from: "pkg/missing/var_providers/x" } },
    mcp: { servers: { unused: { from: "pkg/missing/mcp/x" } } },
    agents: { good: { model: "local", tools: { use: ["builtin/read_file"] } },
      broken: { from: "pkg/missing/agents/x", model: "local" } } }));
  const config = await loadConfig({ configPath, requireModel: false });
  assert.equal(config.agentName, "good");
  assert.deepEqual(config.toolIds, ["builtin/read_file"]);
  assert.equal(config.variableConfig.variables.length, 0);
  await assert.rejects(loadConfig({ configPath, flags: { agent: "broken" }, requireModel: false }), /missing/i);
});

test("agent binding inputs flow into its selected variable export", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-agent-input-"));
  const source = join(root, "source"); mkdirSync(join(source, "agents"), { recursive: true }); mkdirSync(join(source, "vars"));
  writeFileSync(join(source, "agents", "writer.json"), JSON.stringify({ tools: { use: [] }, vars: ["#vars/host"] }));
  writeFileSync(join(source, "vars", "host.json"), JSON.stringify({ description: "Host", access: "read",
    source: { kind: "env", name: { $input: "env_name" } } }));
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/input",
    version: "1.0.0", description: "Input", files: ["agents/writer.json", "vars/host.json"],
    exports: { agents: { writer: "agents/writer.json" }, vars: { host: "vars/host.json" } },
    inputs: { type: "object", properties: { env_name: { type: "string", "x-raw-kind": "env-name" } },
      required: ["env_name"] } }));
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "writer", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { writer: {
    from: "pkg/kit/agents/writer", model: "local", inputs: { env_name: "RAW_FIXTURE_HOST" } } } }));
  await installPackage({ configPath, dataHome, source, alias: "kit" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const runtime = await loadConfig({ configPath, requireModel: false });
    assert.equal((await createVariableResolver({ config: runtime.variableConfig,
      env: { RAW_FIXTURE_HOST: "agent-host" } }).read("host")).value, "agent-host");
    await assert.rejects(addPackageAgent({ configPath, name: "missing_input", from: "pkg/kit/agents/writer",
      model: "local" }), /input/i);
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { agents: Record<string, unknown> }).agents.missing_input, undefined);
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("two packages with the same original tool and skill names coexist through explicit aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-names-"));
  const make = (owner: string) => {
    const source = join(root, owner), tool = join(source, "tools", "echo"), skill = join(source, "skills", "review");
    mkdirSync(tool, { recursive: true }); mkdirSync(skill, { recursive: true });
    writeFileSync(join(tool, "tool.json"), JSON.stringify({ api_version: 2, id: "echo", version: "1.0.0",
      name: "echo", description: "Echo", input_schema: { type: "object", properties: {},
        additionalProperties: false }, entry: "./index.mjs" }));
    writeFileSync(join(tool, "index.mjs"), `export async function handler(){return {content:[{type:'text',text:'${owner}'}]}}\n`);
    writeFileSync(join(skill, "SKILL.md"), `---\nname: review\ndescription: Review ${owner}\n---\nReview ${owner}.\n`);
    writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: `@test/${owner}`,
      version: "1.0.0", description: owner, files: ["tools/echo", "skills/review"],
      exports: { tools: { echo: "tools/echo" }, skills: { review: "skills/review" } } }));
    return source;
  };
  const configPath = join(root, "config.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ default_agent: "raw", models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "test" } }, agents: { raw: { model: "local",
    tools: { use: ["builtin/list_skills", "builtin/load_skill",
      { ref: "pkg/alpha/tools/echo", as: "alpha_echo" }, { ref: "pkg/beta/tools/echo", as: "beta_echo" }] },
    skills: { use: [{ ref: "pkg/alpha/skills/review", as: "alpha_review" },
      { ref: "pkg/beta/skills/review", as: "beta_review" }] } } } }));
  await installPackage({ configPath, dataHome, source: make("alpha"), alias: "alpha" });
  await installPackage({ configPath, dataHome, source: make("beta"), alias: "beta" });
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const runtime = await createRuntimeTools({ runtime: await loadConfig({ configPath, requireModel: false }), cwd: root });
    try {
      assert.deepEqual(runtime.selectedNames.slice(-2), ["alpha_echo", "beta_echo"]);
      assert.deepEqual(runtime.skills.map((item) => item.name), ["alpha_review", "beta_review"]);
      assert.equal(runtime.registry.canonicalIdentity("alpha_echo"), "@test/alpha#tools/echo");
      assert.equal(runtime.registry.canonicalIdentity("beta_echo"), "@test/beta#tools/echo");
    } finally { await runtime.mcp.close(); }
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});
