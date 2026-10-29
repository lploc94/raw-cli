import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { RunEvent } from "../src/agent.js";
import type { AcpBackendAgent } from "../src/backends/acp-agent.js";
import { AGY_APPEND, AGY_DEFAULT_TOOLS, AGY_EMPTY_PROMPT, agyAgentFile, agyModelArgs, agyModeArgs, agyPluginRoot, parseAgyCatalog,
  writeAgyAgent } from "../src/backends/agy.js";
import { createAgySessionAgent, sessionIdentity } from "../src/backends/factory.js";
import { loadConfig, type RuntimeConfig } from "../src/config.js";
import { openSessionStore, type SessionStore, type SessionSummary } from "../src/sessions/store.js";

const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const RECORDINGS = join(import.meta.dirname, "fixtures", "agy");
const FRESH = "This agy conversation starts here; it does not see earlier turns";
/** Text a prompt may hold that no quoting layer may change: quotes, backslashes, shell and cmd.exe specials, newlines, non-ASCII. */
const TRICKY = "He said \"hi\" \\ 100% ^caret !bang `tick` $HOME %PATH% & | < >\nline two\ttab — ünïcødé 🙂\n";

interface Harness {
  root: string; home: string; store: SessionStore; session: SessionSummary; runtime: RuntimeConfig; diagnostics: string[];
  agent(runtime?: RuntimeConfig): AcpBackendAgent;
  reopen(): void;
  calls(): Array<{ argv: string[]; stdin?: string; pid?: number }>;
  pids(prefix: "agy" | "grandchild"): number[];
  cleanup(): void;
}

/** An `agy` executable that runs the fake: a copy with its shebang on POSIX, a .cmd on Windows. */
function fakeAgy(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") { writeFileSync(join(bin, "agy.cmd"), `@"${process.execPath}" "${FAKE}" %*\r\n`); return join(bin, "agy.cmd"); }
  writeFileSync(join(bin, "agy"), readFileSync(FAKE, "utf8").replace("const recordings = join(dirname(fileURLToPath(import.meta.url)), \"agy\");",
    `const recordings = ${JSON.stringify(RECORDINGS)};`));
  chmodSync(join(bin, "agy"), 0o755);
  return join(bin, "agy");
}

async function harness(backend: Record<string, unknown> = {}, agent: Record<string, unknown> = { system_prompt: "Be RAW." }): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "raw-backend-agy-"));
  const home = join(root, "home");
  const state = join(root, "fake");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "ext", agents: { ext: { backend: { kind: "agy", executable: fakeAgy(root), ...backend },
    tools: { use: [] }, ...agent } } }));
  const runtime = await loadConfig({ configPath, env: {} });
  const storeEnv = { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root };
  let store = openSessionStore({ env: storeEnv });
  const session = store.createSession({ cwd: root, title: "New session", ...sessionIdentity(runtime) });
  const diagnostics: string[] = [];
  const env = { ...process.env, HOME: home, USERPROFILE: home, FAKE_AGY_STATE: state };
  const h: Harness = {
    root, home, store, session, runtime, diagnostics,
    agent: (override) => {
      const created = createAgySessionAgent({ runtime: override ?? runtime, tools: undefined as never, cwd: root, env,
        host: { persistence: { store: h.store, sessionId: session.id, surface: "web" } } });
      (created.provider as unknown as { config: { diagnostic: (line: string) => void } }).config.diagnostic = (line) => diagnostics.push(line);
      return created;
    },
    reopen: () => { store.close(); store = openSessionStore({ env: storeEnv }); h.store = store; },
    calls: () => existsSync(join(state, "calls.jsonl")) ? readFileSync(join(state, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((call: { argv: string[] }) => call.argv[0] !== "models") : [],
    pids: (prefix) => { try { return readdirSync(state).filter((name) => name.startsWith(`${prefix}-`)).map((name) => Number(readFileSync(join(state, name), "utf8"))); } catch { return []; } },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
  };
  return h;
}

const notices = (events: RunEvent[]) => events.filter((event) => event.type === "backend_notice").map((event) => (event as { message: string }).message);
async function ask(agent: AcpBackendAgent, input: string) {
  const events: RunEvent[] = [];
  const result = await agent.run(input, (event) => { events.push(event); });
  return { result, events, notices: notices(events), text: result.text ?? "" };
}
const flagValue = (argv: string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pids: number[], ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!pids.some(alive)) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return !pids.some(alive);
}

test("a recorded agy turn becomes Raw's events and history, one result per agy tool step", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    const turn = await ask(agent, "replay turn1");
    assert.equal(turn.result.status, "completed", JSON.stringify(turn.result));
    assert.equal(turn.text, "[RAW_AGY_OK] done\n");
    const types = turn.events.map((event) => event.type);
    assert.equal(types.filter((type) => type === "run_end").length, 1);
    const starts = turn.events.filter((event) => event.type === "tool_start") as Array<Extract<RunEvent, { type: "tool_start" }>>;
    const results = turn.events.filter((event) => event.type === "tool_result") as Array<Extract<RunEvent, { type: "tool_result" }>>;
    assert.deepEqual(starts.map((event) => event.name), ["run_command", "run_command", "write_to_file"]);
    assert.deepEqual(results.map((event) => event.id), starts.map((event) => event.id));
    assert.equal(new Set(starts.map((event) => event.id)).size, 3);
    assert.equal(starts[0]!.display?.title, "echo raw-check");
    assert.equal(starts[0]!.display?.identity, "cli:execute/run_command");
    assert.equal(starts[2]!.display?.identity, "cli:edit/write_to_file");
    // The recorded path, with the fake's working directory in place of the spike's.
    assert.equal(starts[2]!.display?.title, `${h.root}/hello.txt`);
    assert.deepEqual(results[0]!.result, { isError: false, exitCode: 0, content: [{ type: "text", text: "Command exited with code 0.\n\nCommand output:\nraw-check\r\n" }] });
    assert.equal(results[1]!.result.isError, true);
    assert.equal(results[1]!.result.exitCode, 1);
    assert.deepEqual(results[2]!.result, { isError: false, content: [] });
    assert.deepEqual(agent.stats().inputTokensKnown, 20775 + 36286);
    assert.deepEqual(agent.stats().outputTokensKnown, 452 + 248);
    assert.deepEqual(h.diagnostics, []);
    const history = h.store.getSessionHistory({ sessionId: h.session.id }).items.map((item) => item.kind);
    assert.deepEqual(history, ["user", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "assistant", "run_end"]);
    assert.deepEqual(agent.transcript, [{ role: "user", content: "replay turn1" }, { role: "assistant", text: "[RAW_AGY_OK] done\n", toolCalls: [] }]);
    const [call] = h.calls();
    assert.deepEqual(call!.argv.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
    assert.equal(call!.argv.at(-1), "--print=");
    assert.ok(call!.argv.includes("--disable-slash-commands"));
    assert.equal(flagValue(call!.argv, "--conversation"), undefined);
    assert.equal(flagValue(call!.argv, "--agent"), agyAgentFile("ext", "Be RAW.", AGY_DEFAULT_TOOLS).name);
  } finally { await agent.close(); h.cleanup(); }
});

test("the prompt goes to agy byte for byte as one stream-json line on stdin, and a reply only in the result is still the answer", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, `echo ${TRICKY}`);
    const call = h.calls()[0]!;
    assert.equal(call.stdin!.split("\n").length, 2);
    assert.deepEqual(JSON.parse(call.stdin!), { event: "user", message: { role: "user", content: `echo ${TRICKY}` } });
    const turn = await ask(agent, "silent-text");
    assert.equal(turn.text, "from the result only\n");
    assert.ok(turn.events.some((event) => event.type === "text_delta"));
  } finally { await agent.close(); h.cleanup(); }
});

test("each later turn continues the conversation with --conversation, also after reopening; a lost one starts fresh with a notice", async () => {
  const h = await harness();
  let agent = h.agent();
  try {
    await ask(agent, "replay turn1");
    const first = h.calls()[0]!;
    const turn2 = await ask(agent, "replay turn2");
    assert.equal(turn2.text, "[RAW_AGY_OK] raw-check\n");
    assert.deepEqual(turn2.notices, []);
    const conversation = readdirSync(join(h.root, "fake")).find((name) => name.startsWith("conversation-"))!.slice("conversation-".length);
    assert.equal(flagValue(first.argv, "--conversation"), undefined);
    assert.equal(flagValue(h.calls()[1]!.argv, "--conversation"), conversation);
    await agent.close();
    h.reopen();
    agent = h.agent();
    const reopened = await ask(agent, "echo again");
    assert.deepEqual(reopened.notices, []);
    assert.equal(flagValue(h.calls()[2]!.argv, "--conversation"), conversation);
    // agy no longer has the conversation: it warns and starts another, which later turns continue.
    rmSync(join(h.root, "fake", `conversation-${conversation}`));
    const lost = await ask(agent, "echo lost");
    assert.ok(lost.notices.includes(FRESH), JSON.stringify(lost.notices));
    assert.ok(lost.notices.includes(`agy: conversation "${conversation}" not found`));
    const next = flagValue(h.calls()[3]!.argv, "--conversation");
    await ask(agent, "echo next");
    const renewed = flagValue(h.calls()[4]!.argv, "--conversation");
    assert.ok(renewed && renewed !== conversation && next === conversation);
    await agent.close();
    const owner = h.store.claimSession(h.session.id);
    assert.equal(h.store.readExternal(h.session.id, owner)?.cliSessionId, renewed);
    h.store.releaseSession(h.session.id, owner);
  } finally { await agent.close(); h.cleanup(); }
});

test("a changed prompt starts a fresh conversation with a notice", async () => {
  const h = await harness();
  let agent = h.agent();
  try {
    await ask(agent, "echo one");
    await agent.close();
    const changed = await loadConfig({ configPath: join(h.root, "config.json"), env: {} });
    agent = h.agent({ ...changed, systemPrompt: "Be someone else." });
    const turn = await ask(agent, "echo two");
    assert.ok(turn.notices.includes(FRESH));
    assert.equal(flagValue(h.calls()[1]!.argv, "--conversation"), undefined);
  } finally { await agent.close(); h.cleanup(); }
});

test("the catalog groups agy models into families with efforts, and flags follow cross-review's rules", () => {
  const catalog = parseAgyCatalog(readFileSync(join(RECORDINGS, "models.txt"), "utf8"))!;
  assert.deepEqual(catalog.map((model) => [model.slug, model.efforts]), [
    ["gemini-4-argon", ["medium", "high", "low"]], ["gemini-3.8-flash", ["high", "medium", "low"]],
    ["claude-sonnet-4-6", []], ["claude-opus-4-6-thinking", []], ["gpt-oss-120b", ["medium"]]]);
  assert.equal(catalog[0]!.name, "Gemini 4 Argon");
  assert.deepEqual(agyModelArgs({ model: "gemini-3.8-flash", effort: "low" }, catalog), { args: ["--model", "gemini-3.8-flash", "--effort", "low"],
    notices: [], model: "gemini-3.8-flash", effort: "low" });
  // A variant slug names its effort: no --effort, and another effort is reported.
  assert.deepEqual(agyModelArgs({ model: "gemini-4-argon-high", effort: "low" }, catalog), { args: ["--model", "gemini-4-argon-high"],
    notices: ['agy model "gemini-4-argon-high" already names its effort; effort "low" is not applied'], model: "gemini-4-argon-high", effort: "high" });
  assert.deepEqual(agyModelArgs({ model: "claude-sonnet-4-6", effort: "high" }, catalog).args, ["--model", "claude-sonnet-4-6"]);
  assert.deepEqual(agyModelArgs({ model: "claude-sonnet-4-6", effort: "high" }, catalog).notices,
    ['agy model claude-sonnet-4-6 has no effort option; effort "high" is not applied']);
  assert.deepEqual(agyModelArgs({ model: "gemini-3.8-flash", effort: "max" }, catalog).notices,
    ['agy does not offer effort "max" for gemini-3.8-flash; it keeps its default (offered: high, medium, low)']);
  const unknown = agyModelArgs({ model: "gemini-9", effort: "high" }, catalog, "Gemini 3.8 Flash (High)");
  assert.deepEqual(unknown.args, ["--effort", "high"]);
  assert.match(unknown.notices[0]!, /^agy does not offer model "gemini-9"; it keeps its default \(offered: gemini-4-argon, gemini-3.8-flash, /);
  // Without a model the effort is checked against agy's default model.
  assert.deepEqual(agyModelArgs({ effort: "high" }, catalog, "Claude Opus 4.6 (Thinking)").args, []);
  assert.deepEqual(agyModelArgs({ effort: "high" }, catalog, "Gemini 3.8 Flash (Low)").args, ["--effort", "high"]);
  // No catalog: values go to agy as they are, except an effort beside a variant slug.
  assert.deepEqual(agyModelArgs({ model: "x-high", effort: "low" }, undefined).args, ["--model", "x-high"]);
  assert.deepEqual(agyModelArgs({ model: "x", effort: "low" }, undefined).args, ["--model", "x", "--effort", "low"]);
  assert.deepEqual(agyModeArgs("skip-permissions"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(agyModeArgs("plan"), ["--mode", "plan"]);
  assert.deepEqual(agyModeArgs(undefined), []);
  assert.equal(parseAgyCatalog("Fetching available models...\n"), undefined);
});

test("the agent's model, effort and mode reach agy as flags; a value agy does not list is reported and left out", async () => {
  let h = await harness({ model: "gemini-3.8-flash", effort: "high", mode: "skip-permissions" });
  let agent = h.agent();
  try {
    const turn = await ask(agent, "echo flags");
    assert.deepEqual(turn.notices, []);
    const argv = h.calls()[0]!.argv;
    assert.equal(flagValue(argv, "--model"), "gemini-3.8-flash");
    assert.equal(flagValue(argv, "--effort"), "high");
    assert.ok(argv.includes("--dangerously-skip-permissions"));
    assert.equal(agent.provider.currentValue("model"), "gemini-3.8-flash");
    // A per-turn override applies to that turn only.
    agent.setTurnOverride({ model: "claude-sonnet-4-6" });
    await ask(agent, "echo override");
    assert.equal(flagValue(h.calls()[1]!.argv, "--model"), "claude-sonnet-4-6");
    assert.equal(flagValue(h.calls()[1]!.argv, "--effort"), undefined);
    await ask(agent, "echo back");
    assert.equal(flagValue(h.calls()[2]!.argv, "--model"), "gemini-3.8-flash");
  } finally { await agent.close(); h.cleanup(); }
  h = await harness({ model: "gemini-9", mode: "bogus" });
  agent = h.agent();
  try {
    const turn = await ask(agent, "warn");
    assert.equal(turn.result.status, "completed");
    assert.match(turn.notices[0]!, /^agy does not offer model "gemini-9"/);
    assert.ok(turn.notices.includes('agy: unrecognized --mode value "bogus" (valid: accept-edits, auto, plan)'));
    assert.equal(flagValue(h.calls()[0]!.argv, "--model"), undefined);
    assert.equal(flagValue(h.calls()[0]!.argv, "--mode"), "bogus");
  } finally { await agent.close(); h.cleanup(); }
});

test("an agent without a prompt runs agy's own; an empty one and append mode are reported", async () => {
  for (const [agentConfig, backend, expected, withAgent] of [
    [{}, {}, [], false], [{ system_prompt: "" }, {}, [AGY_EMPTY_PROMPT], false],
    [{ system_prompt: "Be RAW." }, { system_prompt_mode: "append" }, [AGY_APPEND], true]] as const) {
    const h = await harness(backend, agentConfig);
    const agent = h.agent();
    try {
      const turn = await ask(agent, "echo prompt");
      assert.deepEqual(turn.notices, expected);
      assert.equal(h.calls()[0]!.argv.includes("--agent"), withAgent);
      assert.equal(h.calls()[0]!.argv.includes("--disable-slash-commands"), withAgent);
    } finally { await agent.close(); h.cleanup(); }
  }
});

test("the agent file lists the tools, is named by its content, and stays after every runtime closed", async () => {
  const h = await harness({ tools: ["run_command", "view_file"] }, { system_prompt: TRICKY });
  const agent = h.agent();
  try {
    await ask(agent, "echo file");
    const root = agyPluginRoot({ HOME: h.home, USERPROFILE: h.home });
    const { name, content } = agyAgentFile("ext", TRICKY, ["run_command", "view_file"]);
    assert.match(name, /^raw-[0-9a-f]{16}$/);
    assert.equal(readFileSync(join(root, "agents", `${name}.md`), "utf8"), content);
    assert.ok(content.startsWith(`---\nname: ${name}\ndescription: "Raw agent ext"\ntools: ["run_command","view_file"]\n---\n`));
    assert.ok(content.endsWith(TRICKY));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).name, "raw");
    assert.notEqual(agyAgentFile("ext", TRICKY, ["run_command"]).name, name);
    assert.notEqual(agyAgentFile("other", TRICKY, ["run_command", "view_file"]).name, name);
    await agent.close();
    const again = h.agent();
    await ask(again, "echo reuse");
    await again.close();
    assert.deepEqual(readdirSync(join(root, "agents")), [`${name}.md`]);
  } finally { await agent.close(); h.cleanup(); }
});

test("concurrent writers of one agent file both end with the complete file, and a reader never sees a partial one", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-agy-file-"));
  try {
    const prompt = `${"Long prompt line.\n".repeat(20000)}END`;
    const { name, content } = agyAgentFile("ext", prompt, AGY_DEFAULT_TOOLS);
    const file = join(root, "agents", `${name}.md`);
    // The prompt is read from a file: on Windows it would not fit on a command line.
    writeFileSync(join(root, "prompt.txt"), prompt);
    writeFileSync(join(root, "writer.mjs"), `import { readFileSync } from "node:fs";
      import { writeAgyAgent } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "backends", "agy.ts")).href)};
      const prompt = readFileSync(${JSON.stringify(join(root, "prompt.txt"))}, "utf8");
      for (let i = 0; i < 20; i++) process.stdout.write(writeAgyAgent(${JSON.stringify(root)}, "ext", prompt, ${JSON.stringify(AGY_DEFAULT_TOOLS)}) + "\\n");\n`);
    const writers = [0, 1, 2].map(() => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", join(root, "writer.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`writer exited ${code}`)));
    }));
    let reads = 0;
    let running = true;
    const reader = (async () => {
      while (running) {
        if (existsSync(file)) { assert.equal(readFileSync(file, "utf8"), content); reads++; }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    let names: string[];
    try { names = await Promise.all(writers); } finally { running = false; }
    await reader;
    for (const out of names) assert.deepEqual(new Set(out.trim().split("\n")), new Set([name]));
    assert.equal(readFileSync(file, "utf8"), content);
    assert.deepEqual(readdirSync(join(root, "agents")), [`${name}.md`]);
    assert.ok(reads > 0);
    assert.equal(writeAgyAgent(root, "ext", prompt, AGY_DEFAULT_TOOLS), name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tool name agy cannot resolve is dropped from the agent and the turn runs again, once", async () => {
  const h = await harness({ tools: ["run_command", "write_to_file", "browser_get_dom", "sed_file"] });
  const agent = h.agent();
  try {
    const turn = await ask(agent, "unknown-tools");
    assert.equal(turn.result.status, "completed", JSON.stringify(turn.result));
    assert.equal(turn.text, "[RAW_AGY_OK] done\n");
    assert.deepEqual(turn.notices, ["agy does not know the tools browser_get_dom, sed_file; the agent runs without them"]);
    const [failed, retried] = h.calls();
    assert.equal(h.calls().length, 2);
    assert.notEqual(flagValue(failed!.argv, "--agent"), flagValue(retried!.argv, "--agent"));
    assert.equal(flagValue(retried!.argv, "--agent"), agyAgentFile("ext", "Be RAW.", ["run_command", "write_to_file"]).name);
    // The runtime keeps the smaller list.
    await ask(agent, "unknown-tools");
    assert.equal(flagValue(h.calls()[2]!.argv, "--agent"), flagValue(retried!.argv, "--agent"));
  } finally { await agent.close(); h.cleanup(); }
  // The default list resolves in agy 1.4.10 as recorded: no retry.
  const usable = await harness();
  const second = usable.agent();
  try {
    const turn = await ask(second, "unknown-tools");
    assert.deepEqual(turn.notices, []);
    assert.equal(usable.calls().length, 1);
  } finally { await second.close(); usable.cleanup(); }
});

test("an agy error result ends the turn with agy's message", async () => {
  const h = await harness({ tools: ["browser_get_dom"] }, { system_prompt: "Be RAW." });
  const agent = h.agent();
  try {
    // The only tool is unknown: after the retry nothing is left to drop, and agy's error ends the turn.
    const turn = await ask(agent, "replay unknown-tools");
    assert.equal(turn.result.status, "error");
    assert.equal(turn.result.code, "backend_error");
    assert.match(turn.result.message ?? "", /^agy: failed to construct executor: .*browser_click_element/s);
    assert.equal(turn.events.filter((event) => event.type === "run_end").length, 1);
  } finally { await agent.close(); h.cleanup(); }
});

test("cancel stops agy and what it started; the turn ends cancelled and the next turn continues the conversation", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    await ask(agent, "echo first");
    const events: RunEvent[] = [];
    const running = agent.run("hang", (event) => { events.push(event); });
    const deadline = Date.now() + 10000;
    while (!h.pids("grandchild").length || !events.some((event) => event.type === "tool_start")) {
      if (Date.now() > deadline) throw new Error("the fake did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const started = Date.now();
    assert.equal(agent.abort(), true);
    const result = await running;
    assert.equal(result.status, "cancelled");
    const tree = [...h.pids("agy"), ...h.pids("grandchild")];
    assert.ok(await gone(tree), `${tree.filter(alive).join(",")} still alive`);
    assert.ok(Date.now() - started < 5000);
    const results = events.filter((event) => event.type === "tool_result") as Array<Extract<RunEvent, { type: "tool_result" }>>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.isError, true);
    assert.equal(events.filter((event) => event.type === "run_end").length, 1);
    const next = await ask(agent, "echo after");
    assert.equal(next.result.status, "completed");
    assert.equal(flagValue(h.calls().at(-1)!.argv, "--conversation"), flagValue(h.calls()[1]!.argv, "--conversation"));
    // The cancelled turn's input was delivered; it is not sent again.
    assert.equal(JSON.parse(h.calls().at(-1)!.stdin!).message.content, "echo after");
  } finally { await agent.close(); h.cleanup(); }
});

test("agy that exits without a result ends the turn backend_exited with its stderr", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    const turn = await ask(agent, "crash");
    assert.equal(turn.result.status, "error");
    assert.equal(turn.result.code, "backend_exited");
    assert.match(turn.result.message ?? "", /code 3.*boom/s);
  } finally { await agent.close(); h.cleanup(); }
});

test("a line over the frame limit ends the turn backend_frame_too_large and stops agy", async () => {
  const h = await harness();
  const agent = h.agent();
  try {
    const turn = await ask(agent, "long");
    assert.equal(turn.result.code, "backend_frame_too_large");
    assert.ok(await gone(h.pids("agy")));
  } finally { await agent.close(); h.cleanup(); }
});

test("agy missing from PATH ends the turn unavailable with the install hint", async () => {
  const h = await harness({ executable: "no-such-agy-raw-test" });
  const agent = h.agent();
  try {
    const turn = await ask(agent, "echo");
    assert.equal(turn.result.code, "backend_unavailable");
    assert.match(turn.result.message ?? "", /Install Antigravity/);
  } finally { await agent.close(); h.cleanup(); }
});
