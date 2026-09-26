import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseCliArgs } from "../src/config.js";
const bin = resolve("dist/raw.js");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "raw-vars-cli-")); const path = join(dir, "config.json");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), RAW_AGENT: "raw" };
  delete env.OPENAI_API_KEY;
  writeFileSync(path, JSON.stringify({ default_agent: "raw", models: { m: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", api_key_env: "RAW_IMPOSSIBLE_KEY" } },
    mcp: { servers: { absent: { transport: "stdio", command: "/absent" } } },
    vars: { flag: { description: "flag", access: "read", source: { kind: "literal", value: false } }, token: { description: "secret", access: "use", source: { kind: "env", name: "UNSET" } } },
    agents: { raw: { model: "m", system_prompt_file: "absent", tools: { use: ["mcp/absent/tool", "agent/absent"] }, vars: ["flag", "token"] } } }));
  return { dir, env, path, run: (...args: string[]) => spawnSync(process.execPath, [bin, "--config", path, ...args], { cwd: dir, env, encoding: "utf8" }) };
}
test("vars CLI returns typed JSON without credentials, assets, MCP or state startup", () => {
  const f = fixture(); const list = f.run("vars", "list"); assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).vars.map((v: { name: string }) => v.name), ["flag", "token"]);
  assert.doesNotMatch(list.stdout, /UNSET|source/);
  const got = f.run("vars", "get", "flag"); assert.equal(got.status, 0, got.stderr); assert.equal(JSON.parse(got.stdout).value, false);
  assert.equal(existsSync(join(f.dir, "state")), false);
  assert.equal(f.run("vars", "get", "token").status, 1); assert.equal(f.run("vars", "get", "absent").status, 1);
  assert.equal(f.run("vars", "get").status, 2); assert.equal(f.run("--agent", "missing", "vars", "list").status, 2);
  const config = f.run("config", "list"); assert.equal(config.status, 0, config.stderr); assert.match(config.stdout, /vars=flag,token/);
});
test("vars parser rejects other command modes and non-utility flags", () => {
  assert.equal(parseCliArgs(["vars", "get", "x"]).variableName, "x");
  for (const args of [["vars"], ["vars","set","x"], ["vars","get","x","y"], ["--resume","id","vars","list"], ["--interactive","vars","list"], ["--max-steps","1","vars","list"], ["--acp","vars","list"]]) assert.throws(() => parseCliArgs(args), /vars/);
});
test("config init ships a raw agent with selected clock and both variable tools", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [bin, "config", "init"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const init = JSON.parse(readFileSync(join(f.env.XDG_CONFIG_HOME!, "raw", "config.json"), "utf8"));
  assert.deepEqual(init.agents.raw.vars, ["now"]);
  for (const tool of ["builtin/list_vars", "builtin/read_var"]) assert.ok(init.agents.raw.tools.use.includes(tool));
});

test("vars get cancellation terminates a running executable and exits 130", async () => {
  const f = fixture(); const marker = join(f.dir, "started"); const script = join(f.dir, "wait.mjs");
  writeFileSync(script, `import {writeFileSync} from 'node:fs';for await(const x of process.stdin){};writeFileSync(${JSON.stringify(marker)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
  const doc = JSON.parse(readFileSync(f.path, "utf8")); doc.var_providers = { wait: { command: process.execPath, args: [script] } };
  doc.vars.flag.source = { kind: "provider", name: "wait" }; writeFileSync(f.path, JSON.stringify(doc));
  const child = spawn(process.execPath, [bin, "--config", f.path, "vars", "get", "flag"], { cwd: f.dir, env: f.env, stdio: "ignore" });
  const closed = new Promise<number | null>(resolve => child.on("close", resolve));
  try {
    const deadline = Date.now()+5000; while (!existsSync(marker) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(existsSync(marker)); child.kill("SIGINT"); assert.equal(await closed,130);
  } finally { child.kill("SIGKILL"); }
});
