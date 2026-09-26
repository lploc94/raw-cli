import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectToolCall, projectToolResult, renderPlainToolResult } from "../src/sessions/visible.js";
import { initializeSessionSchema, SESSION_SCHEMA_VERSION } from "../src/sessions/schema.js";
import { openSessionStore } from "../src/sessions/store.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";

async function raw(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("read batches retain source paths and code text while every row status survives preview truncation", () => {
  const results = Array.from({ length: 16 }, (_, index) => ({ index, path: `src/${index}.ts`,
    status: index === 15 ? "error" : "ok", text: `const value${index} = ${index};\n`.repeat(50),
    ...(index === 15 ? { error: "last row failed" } : {}) }));
  const projected = projectToolResult("read_file", "builtin/read_file", {
    isError: true, content: [{ type: "json", value: { results } }],
  }, 23);
  assert.equal(projected.rows.length, 16);
  assert.equal(projected.rows[15]?.status, "error");
  assert.ok(projected.segments.some((segment) => segment.kind === "code" && segment.path?.endsWith(".ts")));
  assert.ok(projected.segments.reduce((count, segment) => count + [...segment.text].length, 0) <= 2000);
  assert.ok(projected.segments.length <= 9);
  assert.equal(projected.durationMs, 23);
  assert.match(renderPlainToolResult(projected), /15:error/);
});

test("custom and MCP tools that mimic a built-in name remain generic", () => {
  const result = { isError: false, content: [{ type: "json" as const, value: {
    results: [{ index: 0, path: "secret.ts", status: "ok", text: "const secret = 1;" }],
  } }] };
  for (const identity of ["local/fake_read", "mcp/server/read_file", undefined]) {
    const projected = projectToolResult("read_file", identity, result);
    assert.deepEqual(projected.rows, []);
    assert.ok(projected.segments.every((segment) => segment.kind !== "code"));
    assert.match(renderPlainToolResult(projected), /"results"/);
  }
});

test("character cap keeps both ends across nine medium-sized preview lines", () => {
  const content = Array.from({ length: 9 }, (_, index) =>
    `${index === 0 ? "HEAD" : index === 8 ? "TAIL" : `middle${index}`}${"x".repeat(220)}`).join("\n");
  const projected = projectToolResult("search", "mcp/server/search", { isError: false,
    content: [{ type: "text", text: content }] });
  const preview = renderPlainToolResult(projected);
  assert.ok([...preview].length <= 2000);
  assert.match(preview, /HEAD/);
  assert.match(preview, /TAIL/);
  assert.match(preview, /hidden/);
  assert.ok(projected.segments.length <= 9);
});

test("display calls retain Bash commands and omit write payload values", () => {
  const command = "printf 'a'.repeat(200)";
  const bash = projectToolCall("bash", "builtin/bash", { commands: [{ command }] }, false);
  assert.match(JSON.stringify(bash), /printf/);
  const write = projectToolCall("write_file", "builtin/write_file", { operations: [{ path: "src/a.ts", mode: "overwrite", content: "private-value" }] }, true);
  assert.match(JSON.stringify(write), /src\/a.ts/);
  assert.match(JSON.stringify(write), /content_bytes/);
  assert.doesNotMatch(JSON.stringify(write), /private-value/);
  const malformed = projectToolCall("write_file", "builtin/write_file", { path: "a", content: "private-value" }, false);
  assert.deepEqual(malformed.arguments, { argument_keys: ["path", "content"] });
});

test("schema 5 rejects a prior schema without mutation", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA user_version = 4");
    assert.throws(() => initializeSessionSchema(database), /schema version: 4/);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 4);
    database.exec("PRAGMA user_version = 0");
    initializeSessionSchema(database);
    assert.equal(SESSION_SCHEMA_VERSION, 5);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 5);
  } finally { database.close(); }
});

test("CLI read preview survives process restart as path-tagged code without changing provider result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-display-history-"));
  writeFileSync(join(cwd, "sample.ts"), "const answer = 42;\n");
  const env = { ...process.env, XDG_STATE_HOME: join(cwd, "state"), XDG_CONFIG_HOME: join(cwd, "config"), OPENAI_API_KEY: "key" };
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read-one", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ files: [{ path: "sample.ts" }] }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Found it" }, "stop"), openAiDone] },
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const result = await raw(["--config", config, "read code"], cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Found it\n");
    assert.match(JSON.stringify(provider.requests[1]?.body), /const answer = 42/);
    const store = openSessionStore({ env });
    let id: string;
    try {
      id = store.listSessions({ cwd }).items[0]!.id;
      const item = store.getSessionHistory({ sessionId: id }).items.find((entry) => entry.kind === "tool_result");
      const display = item?.payload.display as ReturnType<typeof projectToolResult>;
      assert.equal(display.identity, "builtin/read_file");
      assert.ok(display.segments.some((segment) => segment.kind === "code" && segment.path === "sample.ts"
        && segment.text.includes("const answer = 42")));
    } finally { store.close(); }
    const replay = await raw(["sessions", "show", id], cwd, env);
    assert.equal(replay.code, 0, replay.stderr);
    assert.match(replay.stdout, /const answer = 42/);
  } finally { await provider.close(); }
});
