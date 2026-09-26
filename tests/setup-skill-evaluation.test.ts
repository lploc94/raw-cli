import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, isFresh, gradeRun, sanitizeReport, reserveAttempt, runTurn, cleanEnvironment, preservedSnapshot } from "../scripts/evaluate-setup-skills.mjs";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import { startMockProvider, openAiFrame, openAiDone } from "./fixtures/mock-provider.js";

const skills = ["configure_raw", "create_tool"].map(name => ({ name, description: `Use for ${name}`, version: "1.0.0", markdown: `Instructions ${name}` }));
const caseSpec = { id: "config-how", kind: "how", skill: "configure_raw", prompt: "How do I add a model?" };
const identity = () => fingerprint({ skills, caseSpec, system: "routing", model: { provider: "custom", model: "fixture" }, runner: "v1" });

test("artifact grading ignores interpreter caches but catches unrelated user data changes", () => {
  const spec = { id: "near-app-config", kind: "near" };
  const before = { "work/app-config.json": "old", "home/.config/raw/config.json": "protected" };
  const after = { ...before, "work/app-config.json": "new", "home/Library/Caches/com.apple.python/cache.pyc": "generated" };
  assert.equal(preservedSnapshot(spec, before, after, "home/.config/raw/config.json"), true);
  assert.equal(preservedSnapshot(spec, before, { ...after, "home/.config/raw/config.json": "damaged" }, "home/.config/raw/config.json"), false);
  assert.equal(preservedSnapshot(spec, before, { ...after, "work/unrequested.txt": "added" }, "home/.config/raw/config.json"), false);
});

test("evaluation freshness includes the competing catalog and expected/observed bodies", () => {
  const old = { identity: identity(), expected: ["configure_raw"], loaded: ["configure_raw"] };
  assert.equal(isFresh(old, identity()), true);
  const changed = structuredClone(skills);
  changed[1]!.description += " unrelated new description";
  assert.equal(isFresh(old, fingerprint({ skills: changed, caseSpec, system: "routing", model: { provider: "custom", model: "fixture" }, runner: "v1" })), false);
  const body = structuredClone(skills);
  body[1]!.markdown += " changed";
  const newer = fingerprint({ skills: body, caseSpec, system: "routing", model: { provider: "custom", model: "fixture" }, runner: "v1" });
  assert.equal(isFresh(old, newer), true);
  assert.equal(isFresh({ ...old, loaded: ["configure_raw", "create_tool"] }, newer), false);
  assert.equal(isFresh({ ...old, expected: ["create_tool"], loaded: [] }, newer), false);
  assert.equal(isFresh(old, { ...identity(), case: "different prompt" }), false);
  assert.equal(isFresh(old, { ...identity(), model: "different model" }), false);
});

test("grading inspects real context and artifacts, not the final success claim", () => {
  const transcript = [
    { role: "assistant", text: "", toolCalls: [{ id: "l", name: "list_skills", arguments: {} }, { id: "s", name: "load_skill", arguments: { name: "configure_raw" } }] },
    { role: "tool", name: "load_skill", callId: "s", result: { isError: false, content: [{ type: "text", text: "instructions" }] } },
    { role: "assistant", text: "Successfully configured everything", toolCalls: [] },
  ];
  const base = { caseSpec, transcript, status: "completed", artifacts: [], unchanged: true, sentinels: ["SYNTHETIC_KEY_123"] };
  assert.equal(gradeRun(base).pass, true);
  assert.equal(gradeRun({ ...base, status: "max_steps" }).pass, false);
  assert.equal(gradeRun({ ...base, status: "timeout" }).pass, false);
  assert.equal(gradeRun({ ...base, unchanged: false }).pass, false);
  assert.equal(gradeRun({ ...base, artifacts: [{ name: "requested file exists", pass: false }] }).pass, false);
  assert.equal(gradeRun({ ...base, transcript: [...transcript, { role: "tool", name: "bash", result: { content: [{ type: "text", text: "SYNTHETIC_KEY_123" }] } }] }).pass, false);
  assert.equal(gradeRun({ ...base, transcript: [...transcript, { role: "assistant", toolCalls: [{ name: "bash", arguments: {} }] }] }).pass, false);
  assert.equal(gradeRun({ ...base, caseSpec: { ...caseSpec, kind: "near", skill: null } }).pass, false);
});

test("reports omit real credentials and opaque reasoning but retain synthetic leakage", () => {
  const safe = sanitizeReport({ result: "real-secret and FAKE_SENTINEL", opaque: { reasoning: "private" } }, ["real-secret"]);
  assert.doesNotMatch(JSON.stringify(safe), /real-secret|private|opaque/);
  assert.match(JSON.stringify(safe), /FAKE_SENTINEL/);
  const env = cleanEnvironment({ home: "/tmp/fixture", bin: "/tmp/fixture/bin" });
  assert.equal(env.HOME, "/tmp/fixture");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BASH_ENV, undefined);
});

test("fixed attempt budget survives new invocations and does not authorize stale passes", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-eval-ledger-"));
  try {
    assert.equal(reserveAttempt(root, "candidate", "config-how"), 1);
    assert.equal(reserveAttempt(root, "candidate", "config-how"), 2);
    assert.throws(() => reserveAttempt(root, "candidate", "config-how"), /budget/);
    assert.equal(isFresh({ identity: identity(), expected: ["configure_raw"], loaded: [] }, { ...identity(), catalog: "changed" }), false);
    assert.equal(reserveAttempt(root, "baseline", "config-how"), 1);
    assert.throws(() => reserveAttempt(root, "baseline", "config-how"), /budget/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const modelConfig = { agentName: "fixture", provider: "custom", method: "openai-chat-completions" as const, model: "fixture", vision: false };
test("real AgentSession runner keeps cases separate, captures requests, and bounds a hung provider", async () => {
  const provider: ProviderAdapter = { modelConfig, async generate() { return { text: "done", toolCalls: [], finishReason: "stop" }; } };
  const options = { provider, registry: new ToolRegistry(), skills: [], system: "fixture", cwd: tmpdir(), deadlineMs: 1000 };
  const first = await runTurn({ ...options, input: "first" });
  const second = await runTurn({ ...options, input: "second" });
  assert.equal(first.result.status, "completed");
  assert.equal(first.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(second.transcript), /first/);
  const hung: ProviderAdapter = { modelConfig, generate: () => new Promise(() => {}) };
  const timeout = await runTurn({ ...options, provider: hung, input: "hang", deadlineMs: 25 });
  assert.equal(timeout.result.status, "timeout");
  const failed: ProviderAdapter = { modelConfig, async generate() { throw new Error("fixture failure"); } };
  assert.equal((await runTurn({ ...options, provider: failed, input: "fail" })).result.status, "error");
  let calls = 0;
  const repeating: ProviderAdapter = { modelConfig, async generate() {
    return { text: "", toolCalls: [{ id: `call-${++calls}`, name: "missing", arguments: {} }], finishReason: "tool_calls" };
  } };
  const capped = await runTurn({ ...options, provider: repeating, input: "repeat" });
  assert.equal(capped.result.status, "max_steps");
  assert.equal(capped.requests.length, 12);
  assert.equal(calls, 12);
});

test("CLI evaluation keeps provider credentials in the host and gives actual Bash a clean fixture environment", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-eval-integration-"));
  const command = `node -e 'const fs=require("node:fs"); const p="app-config.json"; const d=JSON.parse(fs.readFileSync(p)); d.retries=3; fs.writeFileSync(p,JSON.stringify(d)); console.log(JSON.stringify({home:process.env.HOME,secret:process.env.EVAL_PROVIDER_SECRET??null,other:process.env.EVAL_OTHER_SECRET??null}));'`;
  const server = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "edit", type: "function", function: { name: "bash", arguments: JSON.stringify({ commands: [{ command }] }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Changed retries to three." }, "stop"), openAiDone] },
  ]);
  try {
    const config = join(root, "provider.json"), output = join(root, "results");
    writeFileSync(config, JSON.stringify({ models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: server.url, api_key_env: "EVAL_PROVIDER_SECRET" } }, agents: { raw: { model: "fixture", tools: { use: [] } } } }));
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/evaluate-setup-skills.mjs", "--variant", "baseline", "--agent", "raw", "--config", config, "--skills-root", "src/skills/bundled", "--output", output, "--case", "near-app-config"], {
      env: { ...process.env, EVAL_PROVIDER_SECRET: "TEST_ONLY_PROVIDER_KEY", EVAL_OTHER_SECRET: "TEST_ONLY_OTHER_KEY" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
    const exit = await new Promise(resolve => child.once("close", resolve));
    assert.equal(exit, 1, stderr); // One requested case passes; the full twelve-case aggregate remains incomplete.
    const serialized = readFileSync(join(output, "near-app-config.json"), "utf8");
    const report = JSON.parse(serialized);
    assert.equal(report.pass, true, serialized);
    assert.equal(server.requests[0]!.headers.authorization, "Bearer TEST_ONLY_PROVIDER_KEY");
    assert.doesNotMatch(stdout + stderr + serialized, /TEST_ONLY_PROVIDER_KEY|TEST_ONLY_OTHER_KEY/);
    const bashResult = report.transcript.find((m: { role: string; name: string }) => m.role === "tool" && m.name === "bash");
    assert.match(JSON.stringify(bashResult), /\\"secret\\":null/);
    assert.match(JSON.stringify(bashResult), /\\"other\\":null/);
    assert.doesNotMatch(readFileSync(join(report.fixtureRoot, "home/.config/raw/config.json"), "utf8"), /TEST_ONLY_PROVIDER_KEY/);
    rmSync(report.fixtureRoot, { recursive: true, force: true });
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});
