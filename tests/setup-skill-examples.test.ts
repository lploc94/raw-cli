import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadSelectedSkills } from "../src/skills/loader.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";
import { inspectPackage } from "../src/packages/inspect.js";
import { loadSelectedHooks } from "../src/hooks/loader.js";
import { runHook } from "../src/hooks/runner.js";

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

test("seven shipped setup skills link complete package guidance and examples validate", async () => {
  for (const id of ["configure_raw", "create_skill", "create_tool", "create_hook", "create_agent", "add_mcp", "create_package"]) {
    const source = body(id);
    const parsed = parseSkillMarkdown(source, id);
    assert.ok(Buffer.byteLength(parsed.markdown) <= 8192, `${id} exceeds load cap`);
    assert.match(parsed.markdown, /references\/packages\.md/);
    const reference = join("src", "skills", "bundled", id, "references", "packages.md");
    assert.match(readFileSync(reference, "utf8"), /raw package/);
    assert.equal(readFileSync(join("dist", "skills", "builtin", id, "SKILL.md"), "utf8"), source);
    assert.equal(readFileSync(join("examples", "skills", id, "references", "packages.md"), "utf8"),
      readFileSync(reference, "utf8"));
  }
  const mixed = await inspectPackage(join("examples", "packages", "mixed-kit"));
  assert.deepEqual(mixed.exports.agents, ["helper"]);
  assert.deepEqual(mixed.exports.tools, ["echo"]);
  assert.deepEqual(mixed.exports.skills, ["repo-review"]);
  assert.deepEqual(mixed.exports.vars, ["host_label"]);
  assert.deepEqual(mixed.exports.var_providers, ["host_label"]);
  assert.deepEqual(mixed.exports.mcp, ["search"]);
  assert.deepEqual(mixed.prerequisites, ["node"]);
  assert.deepEqual((await inspectPackage(join("examples", "packages", "tool-only"))).exports.tools, ["echo"]);
  assert.deepEqual((await inspectPackage(join("examples", "packages", "skill-only"))).exports.skills, ["repo-review"]);
});

test("create_package example packs and activates with recipient inputs after source removal", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-skill-example-"));
  try {
    const source = join(root, "author");
    mkdirSync(join(source, "agents"), { recursive: true });
    mkdirSync(join(source, "vars"));
    mkdirSync(join(source, "hooks", "notice"), { recursive: true });
    writeFileSync(join(source, "raw-package.json"), fence("create_package", "json", "manifest"));
    writeFileSync(join(source, "agents", "helper.json"), fence("create_package", "json", "agent"));
    writeFileSync(join(source, "vars", "project_label.json"), fence("create_package", "json", "var"));
    writeFileSync(join(source, "hooks", "notice", "hook.json"), fence("create_package", "json", "hook-manifest"));
    writeFileSync(join(source, "hooks", "notice", "index.mjs"), fence("create_package", "js", "hook-script") + "\n");
    const recipient = join(root, "recipient");
    mkdirSync(recipient);
    const configPath = join(recipient, "raw.json");
    const original = { default_agent: "existing", models: { local: model() },
      agents: { existing: { model: "local", tools: { use: [] } } } };
    writeFileSync(configPath, JSON.stringify(original));
    const env = { ...process.env, XDG_CONFIG_HOME: join(recipient, "config"),
      XDG_DATA_HOME: join(recipient, "data"), XDG_STATE_HOME: join(recipient, "state") };
    const cli = (args: string[]) => {
      const result = spawnSync(process.execPath, [join(process.cwd(), "dist/raw.js"), ...args],
        { cwd: recipient, env, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const archive = join(recipient, "project-kit-1.0.0.rawpkg");
    cli(["package", "validate", source]);
    cli(["package", "pack", source, "--out", archive]);
    rmSync(source, { recursive: true });
    const report = cli(["package", "inspect", archive]);
    assert.deepEqual(report.exports.agents, ["helper"]);
    assert.deepEqual(report.exports.vars, ["project_label"]);
    assert.deepEqual(report.exports.hooks, ["notice"]);
    cli(["package", "install", archive, "--as", "project-kit", "--config", configPath]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
    const inputsPath = join(recipient, "inputs.json");
    writeFileSync(inputsPath, JSON.stringify({ project_label: "Recipient project" }));
    cli(["agent", "add", "project-helper", "--from", "pkg/project-kit/agents/helper",
      "--model", "local", "--inputs", inputsPath, "--config", configPath]);
    const value = cli(["--config", configPath, "--agent", "project-helper", "vars", "get", "project_label"]);
    assert.equal(value.value, "Recipient project");
    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(updated.default_agent, original.default_agent);
    assert.deepEqual(updated.agents.existing, original.agents.existing);
    assert.equal(updated.agents["project-helper"].model, "local");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
  mkdirSync(join(root, "hooks", "guard"), { recursive: true });
  writeFileSync(join(root, "hooks", "guard", "hook.json"), readFileSync(join("examples", "hooks", "guard", "hook.json")));
  writeFileSync(join(root, "hooks", "guard", "index.mjs"), readFileSync(join("examples", "hooks", "guard", "index.mjs")));
  const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
  assert.equal(runtime.agentName, "writer");
  assert.equal(runtime.systemPrompt, "You are a writing assistant.\n");
  assert.deepEqual(runtime.hookIds, ["agent/guard"]);
  assert.equal((await loadSelectedHooks({ selectedIds: runtime.hookIds, configPath, globalConfigRoot: runtime.globalConfigRoot,
    packageHooks: runtime.packageHooks }))[0]?.events[0]?.name, "PreToolUse");
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

test("create_hook and configure_raw examples select and run a matching gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-hook-skill-example-"));
  try {
    const folder = join(root, "hooks", "guard"); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "hook.json"), fence("create_hook", "json", "manifest"));
    writeFileSync(join(folder, "index.mjs"), fence("create_hook", "js", "script") + "\n");
    const configPath = join(root, "raw.json");
    writeFileSync(configPath, fence("configure_raw", "json", "config"));
    const runtime = await loadConfig({ configPath, env: {}, requireModel: true });
    assert.deepEqual(runtime.hookIds, ["agent/guard"]);
    const hooks = await loadSelectedHooks({ selectedIds: runtime.hookIds, configPath,
      globalConfigRoot: runtime.globalConfigRoot, packageHooks: runtime.packageHooks });
    const decision = await runHook(hooks[0]!, { protocol_version: 2, event: "PreToolUse", cwd: root,
      tool: { identity: "builtin/bash", name: "bash", arguments: { commands: [{ command: "rm old" }] } } });
    assert.equal(decision.decision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
