import assert from "node:assert/strict";
import { testConfig } from "./fixtures/config.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

const stateHome = mkdtempSync(join(tmpdir(), "raw-repl-test-state-"));

function answer(text: string) { return { frames: [openAiFrame({ content: text }, "stop"), openAiDone] }; }

async function waitFor(read: () => string, token: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!read().includes(token)) {
    if (Date.now() > until) throw new Error(`missing ${token}: ${read().slice(-500)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("T-08c: REPL retains turns, compact costs one request, stats/clear cost zero and clear resets history", async () => {
  const fixture = await startMockProvider([
    answer(`first-${"a".repeat(400)}`), answer(`second-${"b".repeat(400)}`), answer(`third-${"c".repeat(400)}`),
    answer("Objective: continue this task."), answer("fourth-answer"), answer("after-clear"),
  ]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "bin/raw.ts",
    "--config", testConfig("openai", "fixture", fixture.url), "--interactive", "-y"],
  { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: stateHome, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const send = (line: string) => { child.stdin.write(`${line}\n`); };
  try {
    await waitFor(() => stdout, "> ");
    send("first task"); await waitFor(() => stdout, "first-");
    send("second task"); await waitFor(() => stdout, "second-");
    send("third task"); await waitFor(() => stdout, "third-");
    const before = fixture.requests.length;
    send("/stats"); await waitFor(() => stderr, '"requests":3');
    assert.equal(fixture.requests.length, before);
    send("/compact"); await waitFor(() => stderr, "raw: compact compacted");
    assert.equal(fixture.requests.length, before + 1);
    send("fourth task"); await waitFor(() => stdout, "fourth-answer");
    const fourth = JSON.stringify(fixture.requests[4]?.body);
    assert.match(fourth, /Conversation summary/);
    assert.match(fourth, /third task/);
    const beforeClear = fixture.requests.length;
    send("/clear"); await waitFor(() => stderr, "conversation cleared");
    assert.equal(fixture.requests.length, beforeClear);
    send("after clear task"); await waitFor(() => stdout, "after-clear");
    const last = JSON.stringify(fixture.requests[5]?.body);
    assert.match(last, /after clear task/);
    assert.doesNotMatch(last, /first task|Conversation summary/);
    send("/exit");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
  } finally { child.kill("SIGKILL"); await fixture.close(); }
});

test("T-08 review: REPL preserves adjacent lines delivered in one stdin chunk", async () => {
  const fixture = await startMockProvider([answer("batched-answer")]);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "bin/raw.ts",
    "--config", testConfig("openai", "fixture", fixture.url), "--interactive", "-y"],
  { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: stateHome, OPENAI_API_KEY: "key" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  try {
    await waitFor(() => stdout, "> ");
    child.stdin.write("one task\n/stats\n/exit\n");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /batched-answer/);
    assert.match(stderr, /"requests":1/);
    assert.equal(fixture.requests.length, 1);
  } finally { child.kill("SIGKILL"); await fixture.close(); }
});
