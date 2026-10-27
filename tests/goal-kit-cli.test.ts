import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addPackageAgent } from "../src/packages/cli.js";
import { packPackage } from "../src/packages/archive.js";
import { installPackage } from "../src/packages/store.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const REPO = process.cwd();
const PACKAGE = join(REPO, "examples/packages/goal-kit");

interface StateApi {
  readState(cwd: string, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined>;
  updateState(cwd: string, mutate: (state: Record<string, unknown>) => Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<unknown>;
}

async function stateApi(): Promise<StateApi> {
  // @ts-expect-error - the shipped package helper is plain .mjs without a declaration file
  return await import("../examples/packages/goal-kit/tools/goal/state.mjs") as unknown as StateApi;
}

function call(id: string, args: Record<string, unknown>, index: number) {
  return { index, id, type: "function", function: { name: "goal", arguments: JSON.stringify(args) } };
}

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO, "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdin.end("");
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raw-goal-cli-"));
  const author = join(root, "author");
  const recipient = join(root, "recipient");
  await mkdir(recipient);
  await cp(PACKAGE, author, { recursive: true });
  const archive = join(root, "goal-kit.rawpkg");
  await packPackage(author, archive);
  await rm(author, { recursive: true, force: true });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(recipient, "config-home"),
    XDG_DATA_HOME: join(recipient, "data-home"),
    XDG_STATE_HOME: join(recipient, "state-home"),
    RAW_GOAL_STATE_DIR: join(recipient, "goal-state"),
    OPENAI_API_KEY: "fixture",
  };
  return { root, recipient, archive, env };
}

function config(providerUrl: string) {
  return {
    models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: providerUrl } },
    agents: {},
  };
}

test("installed goal kit continues, records evidence and completes", { timeout: 60000 }, async () => {
  const { root, recipient, archive, env } = await fixture();
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [call("create", {
      action: "create", objective: "Ship the fix", doneWhen: "Tests pass",
      criteria: [{ id: "c1", label: "Tests pass" }],
    }, 0)] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "working" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [
      call("update", { action: "update", criteria: [{ id: "c1", status: "done", evidence: "npm test" }] }, 0),
      call("complete", { action: "complete" }, 1),
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  try {
    const configPath = join(recipient, "raw.json");
    await writeFile(configPath, JSON.stringify(config(provider.url)));
    await installPackage({ configPath, source: archive, alias: "goal", env });
    await addPackageAgent({ configPath, name: "goal-coder", from: "pkg/goal/agents/coder", model: "fixture", env });
    const result = await run(["--config", configPath, "--agent", "goal-coder", "start"], recipient, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(provider.requests.length, 4, result.stderr);
    const messages = provider.requests.map((request) => {
      const body = request.body as { messages?: Array<{ role: string; content: unknown }> };
      return body.messages?.at(-1)?.content;
    });
    assert.equal(messages[0], "start");
    assert.match(String(messages[2]), /^\[Raw hook continuation\]/);
    const api = await stateApi();
    const state = await api.readState(recipient, env) as Record<string, unknown>;
    assert.equal(state.status, "complete");
    assert.deepEqual((state.criteria as Array<Record<string, unknown>>)[0], {
      id: "c1", label: "Tests pass", required: true, status: "done", evidence: "npm test",
    });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an active goal is paused on a fresh runtime before it can continue", { timeout: 60000 }, async () => {
  const { root, recipient, archive, env } = await fixture();
  const provider = await startMockProvider([
    { frames: [openAiFrame({ content: "one answer" }, "stop"), openAiDone] },
  ]);
  try {
    const configPath = join(recipient, "raw.json");
    await writeFile(configPath, JSON.stringify(config(provider.url)));
    await installPackage({ configPath, source: archive, alias: "goal", env });
    await addPackageAgent({ configPath, name: "goal-coder", from: "pkg/goal/agents/coder", model: "fixture", env });
    const api = await stateApi();
    await api.updateState(recipient, () => ({
      schemaVersion: 1,
      goalId: "00000000-0000-4000-8000-000000000001",
      status: "active",
      objective: "Resume safely",
      doneWhen: "Tests pass",
      criteria: [{ id: "c1", label: "Tests pass", required: true, status: "pending" }],
      steps: [],
      budget: { maxContinuations: 20 },
      baselinePending: true,
      continuations: 0,
      createdAt: 1,
      updatedAt: 1,
    }), env);
    const result = await run(["--config", configPath, "--agent", "goal-coder", "continue"], recipient, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(provider.requests.length, 1, result.stderr);
    const state = await api.readState(recipient, env) as Record<string, unknown>;
    assert.equal(state.status, "paused");
    assert.equal(state.reason, "interrupted");
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
