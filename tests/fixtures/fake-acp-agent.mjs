// A scripted ACP agent standing in for claude-agent-acp / codex-acp. The prompt text chooses the behavior; session state
// (a remembered nonce and the options in use) lives in FAKE_ACP_STATE so `session/load` in a new process resumes it.
// Every process records its pid there (adapter-<pid>.pid, grandchild-<pid>.pid) so tests can check the tree is gone.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";

const stateDir = process.env.FAKE_ACP_STATE;
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, `adapter-${process.pid}.pid`), String(process.pid));
const log = (entry) => writeFileSync(join(stateDir, `calls-${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`, { flag: "a" });

// Claude-agent-acp's effort list depends on the model: here `small` has none, `big` offers low/high, `mid` low/medium.
const EFFORTS = { small: undefined, big: ["low", "high"], mid: ["low", "medium"] };
const MODES = ["ask", "auto"];
const sessionFile = (id) => join(stateDir, `session-${id}.json`);
const readSession = (id) => { try { return JSON.parse(readFileSync(sessionFile(id), "utf8")); } catch { return undefined; } };
const saveSession = (id, value) => writeFileSync(sessionFile(id), JSON.stringify(value));

function configOptions(state) {
  const options = [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: MODES.map((value) => ({ value, name: value })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model,
      options: [{ group: "all", name: "All", options: Object.keys(EFFORTS).map((value) => ({ value, name: value })) }] },
  ];
  const efforts = EFFORTS[state.model];
  if (efforts) options.push({ id: "effort", name: "Effort", category: "thought_level", type: "select",
    currentValue: efforts.includes(state.effort) ? state.effort : efforts[0], options: efforts.map((value) => ({ value, name: value })) });
  return options;
}

const sessions = new Map();
const cancels = new Map();
let client;
const app = agent({ name: "fake-acp" });
const update = (sessionId, value) => client.notify("session/update", { sessionId, update: value });
const text = (sessionId, value) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.onRequest("initialize", async () => (await delay(Number(process.env.FAKE_ACP_INIT_DELAY ?? 0)), { protocolVersion: 1,
  agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD !== "0", promptCapabilities: { image: process.env.FAKE_ACP_IMAGES !== "0" } } }));
app.onRequest("session/new", ({ params }) => {
  const id = `fake-${process.pid}-${sessions.size + 1}`;
  const state = { model: process.env.FAKE_ACP_MODEL ?? "small", effort: undefined, mode: "ask", nonce: undefined, meta: params._meta ?? null };
  sessions.set(id, state); saveSession(id, state);
  log({ method: "session/new", meta: params._meta ?? null });
  return { sessionId: id, configOptions: configOptions(state) };
});
app.onRequest("session/load", async ({ params, client: peer }) => {
  client = peer;
  const state = readSession(params.sessionId);
  log({ method: "session/load", sessionId: params.sessionId, found: Boolean(state) });
  if (!state) throw new Error("Resource not found");
  sessions.set(params.sessionId, state);
  // Real adapters replay the conversation as updates before answering.
  await text(params.sessionId, "REPLAYED");
  return { configOptions: configOptions(state) };
});
app.onRequest("session/set_config_option", ({ params }) => {
  const state = sessions.get(params.sessionId);
  log({ method: "session/set_config_option", configId: params.configId, value: params.value });
  state[params.configId === "effort" ? "effort" : params.configId] = params.value;
  if (params.configId === "model") state.effort = undefined;
  saveSession(params.sessionId, state);
  return { configOptions: configOptions(state) };
});
app.onNotification("session/cancel", ({ params }) => { log({ method: "session/cancel" }); cancels.get(params.sessionId)?.(); });

function grandchild(deaf = false) {
  // A deaf grandchild ignores SIGTERM, as a CLI's long tool command may.
  const child = spawn(process.execPath, ["-e", `${deaf ? "process.on('SIGTERM', () => {}); " : ""}setInterval(() => {}, 1000)`], { stdio: "ignore" });
  writeFileSync(join(stateDir, `grandchild-${child.pid}.pid`), String(child.pid));
}

app.onRequest("session/prompt", async ({ params, client: peer }) => {
  client = peer;
  const id = params.sessionId;
  const state = sessions.get(id);
  const input = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("");
  log({ method: "session/prompt", input, images: params.prompt.filter((block) => block.type === "image").length });
  const cancelled = new Promise((resolve) => cancels.set(id, resolve));
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 20, totalTokens: 135 };
  if (input.includes("grandchild")) grandchild(input.includes("deaf"));
  if (input.includes("crash")) { process.stderr.write("fake adapter: boom\n"); await delay(50); process.exit(3); }
  // Only the newest message blocks, so input that is wrongly sent again fails the test instead of hanging it.
  const newest = input.split("\n\n").at(-1);
  if (newest.includes("stubborn")) await new Promise(() => {});
  if (newest.includes("wait") || newest.includes("silent")) {
    await cancelled;
    return { stopReason: "cancelled" };
  }
  if (input.includes("huge")) { await text(id, "x".repeat(17 * 1024 * 1024)); return { stopReason: "end_turn" }; }
  if (newest === "late-tool") {
    // A tool call that the CLI completes only after it was asked to cancel.
    await update(id, { sessionUpdate: "tool_call", toolCallId: "late-1", name: "Bash", title: "sleep 9", kind: "execute", status: "in_progress",
      rawInput: { command: "sleep 9" } });
    await cancelled;
    await delay(200);
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "late-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "late result" } }] });
    return { stopReason: "cancelled" };
  }
  if (newest === "change-later") {
    // The CLI changes an option between turns (its own command, or the user in another client).
    setTimeout(() => { state.mode = "auto"; saveSession(id, state);
      void update(id, { sessionUpdate: "config_option_update", configOptions: configOptions(state) }); }, 100);
  }
  if (newest === "early-content") {
    await update(id, { sessionUpdate: "tool_call", toolCallId: "read-1", name: "Read", title: "Read a.txt", kind: "read", status: "in_progress", rawInput: { path: "a.txt" } });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "read-1", content: [{ type: "content", content: { type: "text", text: "file text" } }] });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
    await text(id, "read");
    return { stopReason: "end_turn", usage };
  }
  const pause = /pause (\d+)/.exec(input);
  if (pause) { await delay(Number(pause[1])); await text(id, "paused"); return { stopReason: "end_turn", usage }; }
  const remember = /remember (\S+)/.exec(input);
  if (remember) { state.nonce = remember[1]; saveSession(id, state); await text(id, "OK"); return { stopReason: "end_turn", usage }; }
  if (input.includes("recall")) { await text(id, `nonce:${state.nonce ?? "none"}`); return { stopReason: "end_turn", usage }; }
  if (input.includes("options")) {
    const current = Object.fromEntries(configOptions(state).map((option) => [option.id, option.currentValue]));
    await text(id, `model=${current.model} effort=${current.effort ?? "-"} mode=${current.mode}`);
    return { stopReason: "end_turn", usage };
  }
  if (input.includes("permission")) {
    const answer = await client.request("session/request_permission", { sessionId: id,
      toolCall: { toolCallId: "perm-1", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" }] });
    await text(id, `permission:${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
    return { stopReason: "end_turn", usage };
  }
  if (input.includes("tools")) {
    // The order claude-agent-acp 0.98.0 and codex-acp 2.3.0 used on 2026-10-29 for "run a command, then write a file".
    await text(id, "I'll run it.");
    await update(id, { sessionUpdate: "session_info_update", title: "Run it" });
    await update(id, { sessionUpdate: "usage_update", used: 20984, size: 360000 });
    await update(id, { sessionUpdate: "tool_call", toolCallId: "toolu_1", name: "Bash", rawInput: {}, status: "pending", title: "Terminal", kind: "execute", content: [] });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", rawInput: { command: "echo TOOL_OK_123" }, title: "echo TOOL_OK_123" });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", rawInput: { command: "echo TOOL_OK_123", description: "Echo a marker" },
      content: [{ type: "content", content: { type: "text", text: "Echo a marker" } }] });
    await update(id, { sessionUpdate: "usage_update", used: 21478, size: 360000 });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", _meta: { claudeCode: { toolResponse: { stdout: "TOOL_OK_123" } } } });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed", rawOutput: "TOOL_OK_123",
      content: [{ type: "content", content: { type: "text", text: "TOOL_OK_123" } }] });
    await update(id, { sessionUpdate: "tool_call", toolCallId: "exec-2", name: "exec_command", kind: "execute", title: "printf 'hello world\\n' > a.txt",
      status: "in_progress", content: [{ type: "terminal", terminalId: "exec-2" }], rawInput: { command: "printf 'hello world\\n' > a.txt" } });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "exec-2", status: "completed",
      _meta: { terminal_output_delta: { data: "written\n", terminal_id: "exec-2" }, terminal_exit: { exit_code: 0, signal: null, terminal_id: "exec-2" } } });
    await update(id, { sessionUpdate: "tool_call", toolCallId: "edit-3", name: "Edit", kind: "edit", title: "Edit a.txt", status: "pending", rawInput: { path: "a.txt" } });
    await update(id, { sessionUpdate: "tool_call_update", toolCallId: "edit-3", status: "failed",
      content: [{ type: "diff", path: "a.txt", oldText: "hello world", newText: "hello raw" }] });
    await update(id, { sessionUpdate: "plan", entries: [{ content: "run", priority: "high", status: "completed" }, { content: "write", priority: "high", status: "pending" }] });
    await update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    await update(id, { sessionUpdate: "mystery_update", detail: 1 });
    await update(id, { sessionUpdate: "mystery_update", detail: 2 });
    await text(id, "DONE");
    await update(id, { sessionUpdate: "usage_update", used: 26114, size: 1000000 });
    return { stopReason: "end_turn", usage };
  }
  await text(id, `echo:${input}`);
  return { stopReason: "end_turn", usage };
});

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
