import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

test("package data commands and agent add do not open a legacy session store or require credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-cli-"));
  const configPath = join(root, "config.json");
  const stateHome = join(root, "state");
  mkdirSync(stateHome);
  writeFileSync(configPath, JSON.stringify({ models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "fixture" } }, agents: {} }));
  const source = join(root, "source"); mkdirSync(join(source, "agents"), { recursive: true });
  writeFileSync(join(source, "agents", "helper.json"), JSON.stringify({ system_prompt: "hello",
    tools: { use: ["builtin/read_file"] } }));
  writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/helper",
    version: "1.0.0", description: "Helper", files: ["agents/helper.json"],
    exports: { agents: { helper: "agents/helper.json" } } }));
  const env = { ...process.env, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: stateHome,
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "bin/raw.ts", ...args],
    { cwd: process.cwd(), env, encoding: "utf8" });
  const install = run("package", "install", source, "--as", "kit", "--config", configPath);
  assert.equal(install.status, 0, install.stderr);
  const list = run("package", "list", "--config", configPath);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /kit/);
  const add = run("agent", "add", "writer", "--from", "pkg/kit/agents/helper", "--model", "local", "--config", configPath);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).agents.writer.from, "pkg/kit/agents/helper");
  const listedAgent = run("config", "list", "--config", configPath);
  assert.equal(listedAgent.status, 0, listedAgent.stderr);
  assert.match(listedAgent.stdout, /from=pkg\/kit\/agents\/helper/);
  assert.match(listedAgent.stdout, /builtin\/read_file/);
  assert.equal(existsSync(join(stateHome, "raw", "sessions.sqlite")), false);
});

test("author export and archive run as a recipient agent from another config and cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-cli-flow-"));
  const author = join(root, "author"), recipient = join(root, "recipient");
  mkdirSync(author); mkdirSync(recipient);
  const authorConfig = join(author, "config.json"), recipientConfig = join(recipient, "config.json");
  writeFileSync(authorConfig, JSON.stringify({ models: { local: { provider: "ollama",
    method: "openai-chat-completions", model_id: "author-model" } }, agents: { helper: {
    model: "local", system_prompt: "portable prompt", tools: { use: ["builtin/read_file"] } } } }));
  const mock = await startMockProvider([
    { frames: [openAiFrame({ content: "recipient-answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "changed-answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "stable-answer" }, "stop"), openAiDone] },
  ]);
  writeFileSync(recipientConfig, JSON.stringify({ models: { recipient: { provider: "ollama",
    method: "openai-chat-completions", model_id: "recipient-model", base_url: mock.url } }, agents: {} }));
  const env = { ...process.env, XDG_DATA_HOME: join(recipient, "data"), XDG_STATE_HOME: join(recipient, "state") };
  const run = (cwd: string, ...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin", "raw.ts"), ...args],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { out += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { err += part; });
    child.on("exit", (code) => done({ code, out, err }));
  });
  try {
    const source = join(author, "package"), archive = join(author, "helper.rawpkg");
    for (const result of [
      await run(author, "package", "export", "--agent", "helper", "--name", "@test/helper",
        "--version", "1.0.0", "--out", source, "--config", authorConfig),
      await run(author, "package", "pack", source, "--out", archive),
      await run(recipient, "package", "install", archive, "--as", "kit", "--config", recipientConfig),
      await run(recipient, "agent", "add", "assistant", "--from", "pkg/kit/agents/helper",
        "--model", "recipient", "--config", recipientConfig),
    ]) assert.equal(result.code, 0, result.err);
    const response = await run(recipient, "--config", recipientConfig, "--agent", "assistant", "hello");
    assert.equal(response.code, 0, response.err);
    assert.equal(response.out, "recipient-answer\n");
    assert.match(JSON.stringify(mock.requests[0]?.body), /portable prompt/);
    const id = response.err.match(/raw --resume ([0-9a-f-]+) "query"/)?.[1];
    assert.ok(id);
    const agentPath = join(source, "agents", "helper.json");
    const definition = JSON.parse(readFileSync(agentPath, "utf8")) as Record<string, unknown>;
    definition.system_prompt = "portable prompt changed";
    writeFileSync(agentPath, JSON.stringify(definition));
    const updatedArchive = join(author, "helper-updated.rawpkg");
    const repack = await run(author, "package", "pack", source, "--out", updatedArchive);
    assert.equal(repack.code, 0, repack.err);
    const update = await run(recipient, "package", "update", "kit", "--from", updatedArchive,
      "--config", recipientConfig);
    assert.equal(update.code, 0, update.err);
    const changed = await run(recipient, "--resume", id, "second");
    assert.equal(changed.code, 0, changed.err);
    assert.equal(changed.out, "changed-answer\n");
    const stable = await run(recipient, "--resume", id, "third");
    assert.equal(stable.code, 0, stable.err);
    assert.equal(stable.out, "stable-answer\n");
    assert.match(JSON.stringify(mock.requests[1]?.body), /portable prompt changed/);
    assert.equal((mock.requests[1]?.body as { messages?: unknown[] }).messages?.[0] !== undefined, true);
    assert.deepEqual((mock.requests[2]?.body as { messages?: unknown[] }).messages?.slice(0,
      (mock.requests[1]?.body as { messages?: unknown[] }).messages?.length),
    (mock.requests[1]?.body as { messages?: unknown[] }).messages);
  } finally { await mock.close(); }
});
