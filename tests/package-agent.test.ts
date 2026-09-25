import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const done = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const call = (name: string, args: unknown, id: string) => ({ frames: [openAiFrame({ tool_calls: [{
  index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) },
}] }, "tool_calls"), openAiDone] });

async function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

async function forkTool(packageRoot: string, localRoot: string, source: string, id: string, description: string) {
  const target = join(localRoot, id);
  await cp(join(packageRoot, "examples", "tools", source), target, { recursive: true });
  const manifestPath = join(target, "tool.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = id;
  manifest.name = id;
  manifest.description = description;
  manifest.input_schema.description = `${id} edited schema sentinel`;
  await writeFile(manifestPath, JSON.stringify(manifest));
  return target;
}

test("packed forks and copied agent execute outside the checkout with isolated state", async () => {
  const repo = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "raw-portable-"));
  const provider = await startMockProvider([
    call("fork_write", { operations: [
      { path: "must-not-write.txt", mode: "overwrite", content: "side effect" },
      { path: "must-not-write.txt", mode: "replace_lines", start_line: 2, end_line: 1,
        content: "bad", expected_sha256: "0".repeat(64) },
    ] }, "invalid-write"), done("write rejected"),
    call("fork_bash", { commands: [{ command: "touch must-not-run.txt" }, { command: "" }] }, "invalid-bash"), done("bash rejected"),
    call("fork_bash", { commands: [{ command: "printf safe > safe.txt" }] }, "safe-bash"), done("safe done"),
    call("fork_bash", { commands: [{ command: "rm protected.txt" }] }, "gated-bash"),
    done("same generation"), done("new generation"),
    call("list_skills", {}, "list-a"), call("load_skill", { name: "project" }, "load-a"),
    call("project_note", {}, "note-a"), done("agent a"),
    call("list_skills", {}, "list-b"), call("load_skill", { name: "project" }, "load-b"),
    call("project_note", {}, "note-b"), done("agent b"), done("agent resumed"),
  ]);
  try {
    const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" });
    assert.equal(pack.status, 0, pack.stderr);
    const archive = join(root, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), '{"name":"portable-consumer","private":true,"type":"module"}\n');
    const install = spawnSync("npm", ["install", "--prefer-offline", "--legacy-peer-deps", "--ignore-scripts",
      "--no-audit", "--no-fund", archive], { cwd: consumer, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const bin = join(consumer, "node_modules", ".bin", "raw");
    const packageRoot = join(consumer, "node_modules", "raw-cli");
    const xdg = join(root, "xdg");
    const localRoot = join(xdg, "raw", "tools");
    await mkdir(localRoot, { recursive: true });
    await forkTool(packageRoot, localRoot, "write_file", "fork_write", "EDITED_WRITE_DESCRIPTION");
    const bashFolder = await forkTool(packageRoot, localRoot, "bash", "fork_bash", "EDITED_BASH_DESCRIPTION");
    const unselected = join(localRoot, "unused");
    await mkdir(unselected);
    await writeFile(join(unselected, "tool.json"), JSON.stringify({ api_version: 1, id: "unused", version: "1.0.0",
      name: "unused", description: "unused", input_schema: { type: "object" }, entry: "./index.mjs" }));
    await writeFile(join(unselected, "index.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "unselected-imported"))}, "bad");
export async function handler() { return { content: [] }; }`);
    const configPath = join(root, "forks.json");
    await writeFile(configPath, JSON.stringify({ default_profile: "forks", models: { fixture: {
      provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: provider.url,
    } }, profiles: { forks: { model: "fixture", tools: { use: ["local/fork_write", "local/fork_bash"],
      rules: [{ match: "local/fork_bash", effect: "ask", when: {
        any: "commands[*].command", regex: "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)",
      } }],
    } } } }));
    const env = { ...process.env, OPENAI_API_KEY: "fixture", XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(root, "state") };
    const args = ["--config", configPath, "--profile", "forks"];
    const first = await run(bin, [...args, "bad write"], consumer, env);
    assert.equal(first.code, 0, first.stderr);
    const sessionId = first.stderr.match(/raw --resume ([0-9a-f-]{36})/)?.[1];
    assert.ok(sessionId);
    assert.match(JSON.stringify(provider.requests[0]?.body), /EDITED_WRITE_DESCRIPTION|fork_write edited schema sentinel/);
    assert.deepEqual((provider.requests[0]?.body as { tools: Array<{ function: { name: string } }> }).tools.map((item) => item.function.name),
      ["fork_write", "fork_bash"]);
    await assert.rejects(access(join(consumer, "must-not-write.txt")));
    assert.match(JSON.stringify(provider.requests[1]?.body), /invalid line range/);
    assert.equal((await run(bin, [...args, "bad bash"], consumer, env)).code, 0);
    await assert.rejects(access(join(consumer, "must-not-run.txt")));
    assert.match(JSON.stringify(provider.requests[3]?.body), /nonempty string/);
    assert.equal((await run(bin, [...args, "safe bash"], consumer, env)).code, 0);
    assert.equal(await readFile(join(consumer, "safe.txt"), "utf8"), "safe");
    await writeFile(join(consumer, "protected.txt"), "keep");
    const gated = await run(bin, [...args, "rm bash"], consumer, env);
    assert.equal(gated.code, 2, gated.stderr);
    assert.match(gated.stderr, /approval required/);
    assert.equal(await readFile(join(consumer, "protected.txt"), "utf8"), "keep");
    const same = await run(bin, [...args, "--resume", sessionId, "same"], consumer, env);
    assert.equal(same.code, 0, same.stderr);
    const manifestPath = join(bashFolder, "tool.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.description = "CHANGED_BASH_DESCRIPTION";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const changed = await run(bin, [...args, "--resume", sessionId, "changed"], consumer, env);
    assert.equal(changed.code, 0, changed.stderr);
    const before = provider.requests[0]?.body as { prompt_cache_key: string; tools: unknown[] };
    const unchanged = provider.requests[7]?.body as { prompt_cache_key: string; tools: unknown[] };
    const after = provider.requests[8]?.body as { prompt_cache_key: string; tools: unknown[] };
    assert.equal(before.prompt_cache_key, unchanged.prompt_cache_key);
    assert.notEqual(unchanged.prompt_cache_key, after.prompt_cache_key);
    assert.notDeepEqual(unchanged.tools, after.tools);
    await assert.rejects(access(join(root, "unselected-imported")));

    const sourceAgent = join(packageRoot, "examples", "agents", "project-helper");
    const destinations = [join(root, "copy-one", "project-helper"), join(root, "other", "nested", "project-helper")];
    for (const destination of destinations) {
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(sourceAgent, destination, { recursive: true });
      const path = join(destination, "raw.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      config.models.local = { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: provider.url };
      await writeFile(path, JSON.stringify(config));
      assert.doesNotMatch(JSON.stringify(config), new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const firstAgent = await run(bin, ["--config", join(destinations[0]!, "raw.json"), "--profile", "project", "inspect"],
      join(root, "copy-one"), env);
    assert.equal(firstAgent.code, 0, firstAgent.stderr);
    const agentId = firstAgent.stderr.match(/raw --resume ([0-9a-f-]{36})/)?.[1];
    assert.ok(agentId);
    const secondAgent = await run(bin, ["--config", join(destinations[1]!, "raw.json"), "--profile", "project", "inspect"],
      join(root, "other"), env);
    assert.equal(secondAgent.code, 0, secondAgent.stderr);
    const resumeAgent = await run(bin, ["--config", join(destinations[0]!, "raw.json"), "--profile", "project",
      "--resume", agentId, "continue"], join(root, "copy-one"), env);
    assert.equal(resumeAgent.code, 0, resumeAgent.stderr);
    const requestA = provider.requests[9]?.body as { messages: unknown[]; tools: unknown[] };
    const requestB = provider.requests[13]?.body as { messages: unknown[]; tools: unknown[] };
    assert.deepEqual(requestA.tools, requestB.tools);
    assert.deepEqual(requestA.messages[0], requestB.messages[0]);
    assert.match(JSON.stringify(requestA.messages[0]), /project helper/);
    assert.doesNotMatch(JSON.stringify(requestA), /Project inspection/);
    assert.match(JSON.stringify(provider.requests[10]?.body), /Project inspection and reporting steps/);
    assert.match(JSON.stringify(provider.requests[11]?.body), /# Project inspection/);
    assert.match(JSON.stringify(provider.requests[12]?.body), /Project directory:/);
    assert.match(JSON.stringify(provider.requests[14]?.body), /Project inspection and reporting steps/);
    assert.match(JSON.stringify(provider.requests[15]?.body), /# Project inspection/);
    assert.match(JSON.stringify(provider.requests[16]?.body), /Project directory:/);
    assert.match(JSON.stringify(provider.requests[17]?.body), /agent a/);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
