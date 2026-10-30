import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { checkConfig } from "../src/config-check.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
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
  const goal = await inspectPackage(join("examples", "packages", "goal-kit"));
  assert.deepEqual(goal.exports.tools, ["goal"]);
  assert.deepEqual(goal.exports.hooks, ["goal"]);
  assert.deepEqual(goal.exports.skills, ["goal"]);
  assert.ok(goal.requires.includes("raw.stop-continue/1"));
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

test("configure_raw try-candidate replaces the active config only after the candidate is checked and tried", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-config-candidate-"));
  const fixture = await startMockProvider(Array.from({ length: 4 }, () => ({ frames: [openAiFrame({ content: "OK" }, "stop"), openAiDone] })));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const xdg = join(root, "xdg"); mkdirSync(join(xdg, "raw"), { recursive: true });
    const active = join(xdg, "raw", "config.json"), candidate = join(xdg, "raw", "config.candidate.json"), log = join(root, "calls.log");
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    // Each raw call records the active file's bytes as they are when it starts.
    writeFileSync(join(bin, "raw"), `#!/bin/sh\ncat ${quote(active)} >> ${quote(log)}; echo >> ${quote(log)}\n`
      + `exec ${quote(process.execPath)} ${quote(join(process.cwd(), "dist/raw.js"))} "$@"\n`, { mode: 0o700 });
    const example = fence("configure_raw", "sh", "try-candidate");
    const lab = { provider: "custom", method: "openai-chat-completions", model_id: "fixture", base_url: fixture.url, api_key: "k" };
    const original = JSON.stringify({ default_agent: "raw", models: { lab }, agents: { raw: { model: "lab", tools: { use: [] } } }, sessions: { retention_days: 30 } });
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };
    const shell = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
    // Async: the mock provider runs in this process and must keep answering while the script runs.
    const run = async (script: string, edit: (data: any) => void) => {
      rmSync(log, { force: true }); rmSync(`${active}.bak`, { force: true });
      writeFileSync(active, original, { mode: 0o600 });
      const before = statSync(active).mtimeMs;
      // Steps 1-2: copy, then edit the candidate only.
      cpSync(active, candidate);
      const data = JSON.parse(readFileSync(candidate, "utf8")); edit(data); writeFileSync(candidate, JSON.stringify(data));
      const path = join(root, "try.sh"); writeFileSync(path, script);
      const child = spawn(shell, [path, "raw"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
      child.stderr.setEncoding("utf8").on("data", (part: string) => { output += part; });
      const status = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      return { result: { status, output }, before, edited: JSON.stringify(data) };
    };
    // Success: both raw calls saw the original, then the candidate replaced it, with a backup and mode 0600.
    const good = await run(example, (data) => { data.agents.raw.system_prompt = "Tried first."; });
    assert.equal(good.result.status, 0, good.result.output);
    assert.equal(readFileSync(log, "utf8"), `${original}\n${original}\n`);
    assert.equal(readFileSync(active, "utf8"), good.edited);
    assert.equal(readFileSync(`${active}.bak`, "utf8"), original);
    if (process.platform !== "win32") assert.equal(statSync(active).mode & 0o777, 0o600);
    assert.match(JSON.stringify(fixture.requests.at(-1)?.body), /Tried first\./);
    const failures: Array<[string, (data: any) => void]> = [
      ["fails the check", (data) => { data.agents.raw.colour = "red"; }],
      // Passes the check (a missing key is a warning) but the try run cannot start.
      ["fails the try run", (data) => { data.models.lab = { ...lab, api_key: undefined, api_key_env: "RAW_TEST_UNSET_KEY" }; }],
    ];
    const untouched = (outcome: Awaited<ReturnType<typeof run>>, label: string) => {
      assert.notEqual(outcome.result.status, 0, label + outcome.result.output);
      assert.equal(readFileSync(active, "utf8"), original, label);
      assert.equal(statSync(active).mtimeMs, outcome.before, label);
      assert.equal(readFileSync(candidate, "utf8"), outcome.edited, label);
      assert.equal(existsSync(`${active}.bak`), false, label);
    };
    for (const [label, edit] of failures) untouched(await run(example, edit), label);
    // Negative control: without the gating, the same failures replace the active config, and the assertions catch it.
    const unguarded = example.replace(/^set -eu\n/m, "").replaceAll(" || exit 1", "");
    assert.notEqual(unguarded, example);
    for (const [label, edit] of failures) {
      const outcome = await run(unguarded, edit);
      assert.throws(() => untouched(outcome, label), assert.AssertionError);
    }
  } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the safe-edit script in docs/configuration.md is the tested try-candidate script", () => {
  const docs = readFileSync(join("docs", "configuration.md"), "utf8").split("A safe edit of the active config:")[1];
  const script = docs?.match(/\x60\x60\x60sh\n([\s\S]*?)\n\x60\x60\x60/)?.[1];
  // The same bytes as the example whose check and try failures are proven above to leave the active config alone.
  assert.equal(script, fence("configure_raw", "sh", "try-candidate"));
});

test("create_agent cli-agent example checks clean as an agent on a CLI model", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-cli-agent-example-"));
  try {
    const configPath = join(root, "raw.json");
    writeFileSync(configPath, fence("create_agent", "json", "cli-agent"));
    const runtime = await loadConfig({ configPath, flags: { agent: "reviewer" }, requireModel: false });
    assert.equal(runtime.modelConfig, undefined);
    assert.deepEqual({ kind: runtime.backend?.kind, model: runtime.backend?.model, effort: runtime.backend?.effort, mode: runtime.backend?.mode },
      { kind: "codex", model: "gpt-6.1-terra", effort: "high", mode: "read-only" });
    const report = await checkConfig({ configPath, env: { PATH: "" } });
    assert.deepEqual(report.errors, []);
    assert.equal(report.agents[0]?.error, undefined);
    assert.deepEqual(report.agents[0]?.warnings, ["Codex is not installed (looked for codex on PATH)"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create_tool example validates one flat call before side effects and rejects a batch", async () => {
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
    const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");
    const invalid = await tools.registry.dispatch("append_notes", { path: "notes.txt", text: "missing newline" }, context);
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /\{"path":"notes\.txt","text":"Ship the docs\\n"\}/);
    assert.equal(existsSync(join(root, "notes.txt")), false);
    const valid = await tools.registry.dispatch("append_notes", { path: "notes.txt", text: "valid\n" }, context);
    assert.equal(valid.isError, false);
    assert.equal(text(valid), "Appended 6 bytes to notes.txt");
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "valid\n");
    const again = await tools.registry.dispatch("append_notes", { path: "notes.txt", text: "next\n" }, context);
    assert.equal(again.isError, false);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "valid\nnext\n");
    const batch = await tools.registry.dispatch("append_notes", { operations: [{ path: "notes.txt", text: "bad\n" }] }, context);
    assert.equal(batch.isError, true);
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
      const safe = await loaded.registry.dispatch("bash", { command: "printf safe" }, context);
      assert.equal(safe.isError, false);
      const gated = await loaded.registry.dispatch("bash", { command: "rm nonexistent" }, context);
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
      tool: { identity: "builtin/bash", name: "bash", arguments: { command: "rm old" } } });
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
