#!/usr/bin/env node
// A stand-in `agy` (1.4.10) for tests: `agy models` prints the recorded catalog; a turn reads one stream-json user message
// from stdin and replays recorded stream-json from tests/fixtures/agy (real agy output, paths and ids replaced). The first
// word of the message picks the behavior. Every call is logged to $FAKE_AGY_STATE/calls.jsonl.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const recordings = join(dirname(fileURLToPath(import.meta.url)), "agy");
const state = process.env.FAKE_AGY_STATE;
mkdirSync(state, { recursive: true });
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(join(state, "calls.jsonl"), `${JSON.stringify(entry)}\n`);
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const out = (line) => process.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);

if (argv[0] === "models") {
  log({ argv });
  // FAKE_AGY_MODELS_FAIL: this many reads fail first (a transient failure).
  const failures = Number(process.env.FAKE_AGY_MODELS_FAIL ?? 0);
  const reads = readdirSync(state).filter((name) => name.startsWith("models-read-")).length;
  writeFileSync(join(state, `models-read-${reads}`), "");
  if (reads < failures) { process.stderr.write("error: cannot reach the model service\n"); process.exit(1); }
  process.stderr.write("Fetching available models...\n");
  process.stdout.write(readFileSync(join(recordings, "models.txt")));
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { void turn(); });

/** The tool names agy 1.4.10 lists but cannot resolve: exactly those its recorded failure names. */
const unresolved = () => [...readFileSync(join(recordings, "unknown-tools.jsonl"), "utf8").matchAll(/^unknown component: tool "([^"]+)"|^error: .*?tool "([^"]+)"/gm)]
  .map((match) => match[1] ?? match[2]);

function agentFile(name) {
  const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  const file = join(home, ".gemini", "config", "plugins", "raw", "agents", `${name}.md`);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const tools = JSON.parse(/^tools: (.*)$/m.exec(text)[1]);
  return { text, tools, body: text.slice(text.indexOf("\n---\n") + 5) };
}

async function replay(name, values) {
  const json = (text) => JSON.stringify(text).slice(1, -1);
  for (const line of readFileSync(join(recordings, `${name}.jsonl`), "utf8").split("\n")) {
    if (!line) continue;
    out(line.replaceAll("{{CONVERSATION}}", values.conversation).replaceAll("{{CWD}}", json(process.cwd())).replaceAll("{{AGENT}}", json(values.agent ?? "")));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function turn() {
  const message = JSON.parse(input.trim());
  const text = message.message.content;
  log({ argv, stdin: input, pid: process.pid });
  writeFileSync(join(state, `agy-${process.pid}.pid`), String(process.pid));
  const requested = flag("--conversation");
  let conversation = requested;
  if (!requested || !existsSync(join(state, `conversation-${requested}`))) {
    if (requested) process.stderr.write(`warning: conversation "${requested}" not found\n`);
    conversation = randomUUID();
  }
  appendFileSync(join(state, `conversation-${conversation}`), `${text}\n`);
  const agentName = flag("--agent");
  const agent = agentName ? agentFile(agentName) : undefined;
  const values = { conversation, agent: agentName };
  const word = text.split(/\s/, 1)[0];
  const init = { event: "init", conversation_id: conversation, init: { cwd: process.cwd(), ...(agentName ? { agent: agentName } : {}), tools: [], permission_mode: "request-review" } };
  const result = (response) => ({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response, duration_seconds: 1, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 5, total_tokens: 12 } } });
  // As agy 1.4.10 answers an unknown --model: on stderr and as an error result with no conversation.
  const model = flag("--model");
  const known = readFileSync(join(recordings, "models.txt"), "utf8").split("\n").map((line) => line.split("\t")[0]).filter(Boolean)
    .flatMap((slug) => [slug, slug.replace(/-(minimal|low|medium|high|xhigh|max)$/, "")]);
  if (model && !known.includes(model)) {
    const error = `invalid model selection (--model "${model}" --effort "${flag("--effort") ?? ""}"): model ${model} is not recognized as a known model or custom model in settings`;
    process.stderr.write(`error: ${error}\n`);
    out({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error } });
    return;
  }
  if (agentName && !agent) { out({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: `agent ${agentName} not found` } }); return; }
  if (word === "replay") return replay(text.split(/\s/)[1], values);
  if (word === "unknown-tools") {
    const bad = (agent?.tools ?? []).filter((name) => unresolved().includes(name));
    if (!bad.length) return replay("usable", values);
    const error = `failed to construct executor: failed to resolve components: ${bad.map((name) => `unknown component: tool "${name}" not found in registry`).join("\n")}`;
    out(init);
    out(`error: ${error}`);
    out({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error, duration_seconds: 0, num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } });
    return;
  }
  if (word === "echo") {
    out(init);
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ECHO" } });
    out(result("ECHO"));
    return;
  }
  if (word === "silent-text") { out(init); out(result("from the result only\n")); return; }
  if (word === "warn") { process.stderr.write("warning: unrecognized --mode value \"bogus\" (valid: accept-edits, auto, plan)\n"); out(init); out(result("OK")); return; }
  if (word === "slow-exit") {
    // Saves the conversation after its result, as agy does, then exits.
    out(init); out(result("OK"));
    setTimeout(() => { writeFileSync(join(state, `saved-${conversation}`), ""); process.exit(0); }, Number(text.split(/\s/)[1] ?? 1500));
    setInterval(() => {}, 1000);
    return;
  }
  if (word === "noisy") {
    out(init);
    for (let i = 0; i < 200; i++) out(`not json ${i} ${"y".repeat(1000)}`);
    process.stderr.write("z".repeat(1024 * 1024));
    process.stderr.write("\nwarning: after the long line\n", () => process.exit(3));
    return;
  }
  if (word === "crash") { out(init); process.stderr.write("boom\n"); process.exit(3); }
  if (word === "long") { out(init); process.stdout.write("x".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000); return; }
  if (word === "hang") {
    out(init);
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "sleep 600" } } } });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(join(state, `grandchild-${child.pid}.pid`), String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  out(init);
  out(result(`unknown fake input: ${word}`));
}
