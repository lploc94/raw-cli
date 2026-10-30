import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { ModelMessage, ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { SessionOperations, type AttachSessionRuntime, type SessionOperation } from "../src/sessions/operations.js";
import { openSessionStore, type SessionOwner } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-queue-"));
  const options = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  const store = openSessionStore(options);
  const session = store.createSession({ cwd: root, title: "New session" });
  const intent = { sessionId: session.id, clientRequestId: "first", kind: "turn" as const,
    input: "do it", agentName: "test", configPath: join(root, "config.json") };
  return { root, options, store, session, intent, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const modelConfig = { agentName: "test", provider: "ollama" as const, method: "openai-chat-completions" as const,
  model: "fixture", contextWindow: 8192, maxOutputTokens: 512 };

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One line per message: `user:<text>`, `tool:<call id>` or `assistant:<text>`. */
function lines(messages: readonly ModelMessage[]): string[] {
  return messages.map((message) => message.role === "user"
    ? `user:${typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("")}`
    : message.role === "tool" ? `tool:${message.callId}` : `assistant:${message.text}`);
}

/** A hook that denies messages containing "forbidden", hangs on "slow", and logs every input it sees. */
function guardHook(root: string) {
  const script = join(root, "guard.mjs"); const log = join(root, "guard.log");
  writeFileSync(script, `import { appendFileSync } from "node:fs";
let input = ""; process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input); const text = JSON.stringify(request.input);
  appendFileSync(process.argv[2], text + "\\n");
  if (text.includes("forbidden")) process.stdout.write(JSON.stringify({ decision: "deny", reason: "not allowed here" }));
  else if (text.includes("slow")) setTimeout(() => process.stdout.write("{}"), 10000);
  else process.stdout.write("{}");
});
`);
  const hooks = new HookDispatcher([{ protocol_version: 2, id: "agent/guard", name: "guard", folder: root, command: process.execPath,
    args: [script, log], timeoutMs: 15000, events: [{ name: "UserPromptSubmit" }] }]);
  return { hooks, seen: () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown); } catch { return []; } } };
}

function harness(options: {
  generate: (request: ProviderRequest, index: number) => Promise<ProviderTurn>;
  registry?: ToolRegistry; hooks?: HookDispatcher; approve?: () => Promise<boolean>; maxSteps?: number;
  beforeAttach?: (operation: SessionOperation) => Promise<void>;
  /** Runs while the operation's runtime closes, after the agent returned. */
  closing?: () => Promise<void>;
}) {
  const f = fixture();
  const requests: ModelMessage[][] = [];
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig, async generate(request) {
    requests.push(structuredClone([...request.messages])); return options.generate(request, calls++);
  } };
  const owners = new Map<string, SessionOwner>();
  const attach: AttachSessionRuntime = async ({ owner, operation }) => {
    owners.set(operation.id, owner);
    await options.beforeAttach?.(operation);
    return { agent: createAgent({ provider, cwd: f.root, deliverQueuedInputs: true, maxSteps: options.maxSteps ?? 10,
      ...(options.registry ? { registry: options.registry } : {}), ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.approve ? { autoApprove: false, approve: options.approve } : {}),
      persistence: { store: f.store, sessionId: f.session.id, surface: "web", owner, ownership: "host", operationId: operation.id } }),
    modelConfig, compactOptions: { keepRecentTurns: 1, maxOutputTokens: 64 }, async close() { await options.closing?.(); } };
  };
  const service = new SessionOperations({ store: f.store, attach });
  const send = (key: string, input: string) => service.enqueue({ ...f.intent, clientRequestId: key, input }, { mode: "queue" });
  const row = (key: string) => f.store.findQueuedInput(f.session.id, key);
  const users = () => f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items.filter((item) => item.kind === "user");
  return { ...f, requests, owners, service, send, row, users,
    async close() { await service.close(); f.cleanup(); } };
}

/** A registry with one tool that waits for `release` before it returns. */
function waitingTool(release: Promise<void>, started?: () => void) {
  const registry = new ToolRegistry();
  registry.register({ name: "work", description: "Work", inputSchema: { type: "object" }, async handler() {
    started?.(); await release; return { isError: false, content: [{ type: "text", text: "worked" }] };
  } });
  return registry;
}
const toolStep: ProviderTurn = { text: "", toolCalls: [{ id: "call-1", name: "work", arguments: {} }], finishReason: "tool_calls" };
const answer = (text: string): ProviderTurn => ({ text, toolCalls: [], finishReason: "stop" });

test("a queued message is claimed, delivered and recorded in one transaction", () => {
  const f = fixture();
  try {
    const owner = f.store.claimSession(f.session.id);
    const queued = f.store.enqueueInput(f.session.id, owner, { ...f.intent, clientRequestId: "q", input: "later", mode: "queue",
      blocks: [{ type: "text", text: "later" }, { type: "image", mimeType: "image/png", data: Buffer.alloc(90_000, 7).toString("base64"), name: "shot.png" }] });
    assert.equal(queued.state, "queued"); assert.equal(queued.text, "later");
    assert.deepEqual(queued.attachments?.map((item) => item.name), ["shot.png"]);
    const claimed = f.store.claimQueuedInput(f.session.id, owner)!;
    assert.equal(claimed.id, queued.id); assert.equal(f.store.queuedInputs(f.session.id)[0]?.state, "delivering");
    assert.ok(Array.isArray(claimed.input) && claimed.input[1]?.type === "image");
    const before = f.store.historyWatermark(f.session.id);
    // A commit that names a row which is not being delivered changes nothing.
    assert.throws(() => f.store.appendAgentMessage(f.session.id, owner, { role: "user", content: "other" }, {},
      [{ kind: "user", payload: { input: "other", queued: true } }], undefined, undefined, undefined, { id: "missing", operationId: "op" }));
    assert.equal(f.store.historyWatermark(f.session.id), before);
    f.store.appendAgentMessage(f.session.id, owner, { role: "user", content: claimed.input }, {},
      [{ kind: "user", payload: { input: claimed.input, queued: true } }], undefined, undefined, undefined, { id: claimed.id, operationId: "op" });
    const delivered = f.store.findQueuedInput(f.session.id, "q")!;
    assert.equal(delivered.state, "delivered"); assert.equal(delivered.operationId, "op");
    assert.equal(delivered.historySequence, f.store.historyWatermark(f.session.id));
    assert.deepEqual(f.store.queuedInputs(f.session.id), []);
    const stored = f.store.database.prepare("SELECT input_text, blocks_json FROM session_queued_inputs WHERE id = ?").get(queued.id)!;
    assert.equal(stored.input_text, null); assert.equal(stored.blocks_json, null);
    f.store.releaseSession(f.session.id, owner);
  } finally { f.cleanup(); }
});

test("delete answers already_sent once delivery claimed the row, and a deleted row is never claimed", () => {
  const f = fixture();
  try {
    const owner = f.store.claimSession(f.session.id);
    const first = f.store.enqueueInput(f.session.id, owner, { ...f.intent, clientRequestId: "a", input: "a", mode: "queue" });
    f.store.claimQueuedInput(f.session.id, owner);
    assert.throws(() => f.store.deleteQueuedInput(f.session.id, first.id), /already_sent|already/);
    const second = f.store.enqueueInput(f.session.id, owner, { ...f.intent, clientRequestId: "b", input: "b", mode: "queue" });
    f.store.deleteQueuedInput(f.session.id, second.id);
    assert.equal(f.store.findQueuedInput(f.session.id, "b")?.state, "deleted");
    assert.equal(f.store.claimQueuedInput(f.session.id, owner), undefined);
    assert.deepEqual(f.store.queuedInputs(f.session.id).map((item) => item.id), [first.id]);
    f.store.releaseSession(f.session.id, owner);
  } finally { f.cleanup(); }
});

test("a session holds at most 20 open queued messages and a request id names one message", () => {
  const f = fixture();
  try {
    const owner = f.store.claimSession(f.session.id);
    const add = (key: string, input = key) => f.store.enqueueInput(f.session.id, owner, { ...f.intent, clientRequestId: key, input, mode: "queue" });
    for (let index = 0; index < 20; index++) add(`k${index}`);
    assert.equal(add("k3").id, f.store.findQueuedInput(f.session.id, "k3")!.id);
    assert.throws(() => add("k3", "changed"), /conflict/);
    assert.throws(() => add("k20"), (error: Error & { code?: string }) => error.code === "queue_full");
    f.store.deleteQueuedInput(f.session.id, f.store.findQueuedInput(f.session.id, "k0")!.id);
    assert.equal(add("k20").state, "queued");
    f.store.releaseSession(f.session.id, owner);
    assert.throws(() => add("k21"), /ownership lost/);
  } finally { f.cleanup(); }
});

test("queued messages reach the model after the step's tool results, oldest first, each through UserPromptSubmit", async () => {
  const release = gate(); const started = gate();
  const root = mkdtempSync(join(tmpdir(), "raw-queue-hook-"));
  const guard = guardHook(root);
  const h = harness({ registry: waitingTool(release.promise, started.open), hooks: guard.hooks,
    generate: async (_request, index) => index === 0 ? toolStep : answer("done") });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await started.promise;
    for (const [key, input] of [["one", "first queued"], ["two", "forbidden plan"], ["three", "third queued"]] as const) {
      assert.equal(("queued" in h.send(key, input)) && h.row(key)?.state, "queued");
    }
    release.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    assert.equal(h.requests.length, 2);
    assert.deepEqual(lines(h.requests[1]!).slice(-4), ["assistant:", "tool:call-1", "user:first queued", "user:third queued"]);
    assert.equal(h.row("one")?.state, "delivered"); assert.equal(h.row("three")?.state, "delivered");
    assert.equal(h.row("one")?.operationId, operation.id);
    const blocked = h.store.queuedInputs(h.session.id);
    assert.deepEqual(blocked.map((item) => [item.clientRequestId, item.state, item.reason]), [["two", "blocked", "not allowed here"]]);
    assert.deepEqual(guard.seen(), ["do it", "first queued", "forbidden plan", "third queued"]);
    const users = h.users();
    assert.deepEqual(users.map((item) => [item.payload.input, item.payload.queued ?? false, item.payload.operationId]),
      [["do it", false, operation.id], ["first queued", true, operation.id], ["third queued", true, operation.id]]);
    assert.equal(h.row("one")?.historySequence, users[1]!.sequence);
  } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a message queued while the turn starts is delivered after the turn's own message, before the first request", async () => {
  const attaching = gate(); const proceed = gate();
  const h = harness({ beforeAttach: async () => { attaching.open(); await proceed.promise; }, generate: async () => answer("done") });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await attaching.promise;
    assert.ok("queued" in h.send("early", "while starting"));
    proceed.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    assert.deepEqual(lines(h.requests[0]!), ["user:do it", "user:while starting"]);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test("a pending approval holds delivery until the step ends; the queue never answers it", async () => {
  const approval = gate(); const asked = gate(); let allowed = false;
  const registry = new ToolRegistry();
  registry.register({ name: "work", description: "Work", inputSchema: { type: "object" }, async handler() {
    return { isError: false, content: [{ type: "text", text: "worked" }] };
  } });
  const h = harness({ registry, approve: async () => { asked.open(); await approval.promise; allowed = true; return true; },
    generate: async (_request, index) => index === 0 ? toolStep : answer("done") });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await asked.promise;
    h.send("q", "while asking");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.row("q")?.state, "queued"); assert.equal(h.requests.length, 1); assert.equal(allowed, false);
    approval.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    assert.deepEqual(lines(h.requests[1]!).slice(-2), ["tool:call-1", "user:while asking"]);
  } finally { await h.close(); }
});

test("Stop while a queued message is being delivered puts it back and pauses it", async () => {
  const release = gate(); const started = gate();
  const root = mkdtempSync(join(tmpdir(), "raw-queue-hook-"));
  const h = harness({ registry: waitingTool(release.promise, started.open), hooks: guardHook(root).hooks,
    generate: async (_request, index) => index === 0 ? toolStep : answer("done") });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await started.promise;
    h.send("q", "slow message");
    release.open();
    await until(() => h.row("q")?.state === "delivering", "the delivery to start");
    assert.ok(h.service.cancel(operation.id));
    assert.equal((await h.service.wait(operation.id)).state, "cancelled");
    assert.equal(h.row("q")?.state, "paused");
    assert.equal(h.requests.length, 1);
    assert.equal(h.users().length, 1);
  } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
});

test("panel notes travel with a queued message and are cleared with it", async () => {
  const release = gate(); const started = gate();
  const h = harness({ registry: waitingTool(release.promise, started.open), generate: async (_request, index) => index === 0 ? toolStep : answer("done") });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await started.promise;
    h.store.commitPanelAction(h.session.id, h.owners.get(operation.id)!, { display: [], note: "The user ticked a box." });
    h.send("q", "queued");
    release.open();
    await h.service.wait(operation.id);
    assert.equal(lines(h.requests[1]!).at(-1), "user:The user ticked a box.\n\nqueued");
    assert.deepEqual(h.store.pendingNotes(h.session.id), []);
  } finally { await h.close(); }
});

test("after an answer cut at the output limit the queued message follows the notice, exactly once", async () => {
  const first = gate(); const entered = gate();
  const h = harness({ generate: async (_request, index) => {
    if (index === 0) { entered.open(); await first.promise; return { text: "partial", toolCalls: [], finishReason: "length", truncated: true }; }
    return answer("rest");
  } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("q", "also this");
    first.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    assert.equal(h.requests.length, 2);
    const sent = lines(h.requests[1]!);
    assert.match(sent.at(-2)!, /^user:\[Raw output limit notice\]/);
    assert.equal(sent.at(-1), "user:also this");
    assert.equal(sent.filter((line) => line === "user:also this").length, 1);
  } finally { await h.close(); }
});

test("leftover messages become the next turn without the session lease lapsing", async () => {
  const answering = gate(); const entered = gate(); let competing: unknown;
  const h = harness({
    beforeAttach: async (operation) => {
      if (operation.clientRequestId !== "next") return;
      const other = openSessionStore(h.options);
      try { other.claimSession(h.session.id); competing = "claimed"; } catch (error) { competing = error; } finally { other.close(); }
    },
    generate: async (_request, index) => { if (index === 0) { entered.open(); await answering.promise; } return answer(`answer ${index}`); } });
  try {
    h.store.database.exec(`CREATE TEMP TABLE releases(generation INTEGER);
      CREATE TEMP TRIGGER record_release AFTER UPDATE OF owner_token ON sessions WHEN NEW.owner_token IS NULL
      BEGIN INSERT INTO releases VALUES (OLD.owner_generation); END;`);
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("next", "second message"); h.send("after", "third message");
    answering.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    await until(() => h.row("next")?.state === "taken", "the hand-off");
    const successor = h.store.findOperation(h.session.id, "next")!;
    assert.equal(h.row("next")?.operationId, successor.id);
    assert.equal(successor.input, "second message");
    assert.equal(successor.ownerGeneration, operation.ownerGeneration + 1);
    assert.equal((await h.service.wait(successor.id)).state, "completed");
    assert.ok(competing instanceof Error && /busy/.test(competing.message), String(competing));
    assert.deepEqual(lines(h.requests[1]!).slice(-2), ["user:second message", "user:third message"]);
    assert.equal(h.row("after")?.state, "delivered"); assert.equal(h.row("after")?.operationId, successor.id);
    assert.deepEqual(h.store.database.prepare("SELECT generation FROM releases").all().map((item) => Number(item.generation)), [successor.ownerGeneration]);
  } finally { await h.close(); }
});

test("a failed hand-off pauses the message with the reason and still ends the previous turn", async () => {
  const answering = gate(); const entered = gate();
  const h = harness({ generate: async (_request, index) => { if (index === 0) { entered.open(); await answering.promise; } return answer("done"); } });
  try {
    h.store.database.exec(`CREATE TEMP TRIGGER fail_hand_off BEFORE INSERT ON session_operations WHEN NEW.client_request_id = 'boom'
      BEGIN SELECT RAISE(ABORT, 'injected hand-off failure'); END;`);
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("boom", "next");
    answering.open();
    assert.equal((await h.service.wait(operation.id)).state, "completed");
    const row = h.store.queuedInputs(h.session.id)[0]!;
    assert.equal(row.state, "paused"); assert.match(row.reason ?? "", /injected hand-off failure/);
    assert.equal(h.store.findOperation(h.session.id, "boom"), undefined);
    await until(() => !h.store.sessionIsBusy(h.session.id), "the session to be released");
  } finally { await h.close(); }
});

for (const ending of ["stop", "error", "max_steps"] as const) test(`${ending} pauses every queued message and starts nothing`, async () => {
  const entered = gate(); const proceed = gate();
  const h = harness({ maxSteps: 1, registry: waitingTool(Promise.resolve()), generate: async (request) => {
    entered.open();
    if (ending === "stop") await new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    await proceed.promise;
    if (ending === "error") throw new Error("provider failed");
    return toolStep;
  } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("a", "one"); h.send("b", "two");
    if (ending === "stop") h.service.cancel(operation.id); else proceed.open();
    assert.equal((await h.service.wait(operation.id)).state, ending === "stop" ? "cancelled" : ending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(h.store.queuedInputs(h.session.id).map((item) => item.state), ["paused", "paused"]);
    assert.equal(h.store.findOperation(h.session.id, "a"), undefined);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test("Stop while a completed turn cleans up pauses the queue instead of starting the next turn", async () => {
  const answering = gate(); const entered = gate(); const closing = gate(); const closed = gate(); let closes = 0;
  const h = harness({ closing: async () => { if (closes++ === 0) { closing.open(); await closed.promise; } },
    generate: async (_request, index) => { if (index === 0) { entered.open(); await answering.promise; } return answer("done"); } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("next", "second message");
    answering.open();
    await closing.promise;
    assert.ok(h.service.cancel(operation.id));
    closed.open();
    await h.service.wait(operation.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.row("next")?.state, "paused");
    assert.equal(h.store.findOperation(h.session.id, "next"), undefined);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test("a restart pauses the queued messages of an interrupted turn", () => {
  const f = fixture();
  try {
    const { operation, owner } = f.store.acceptOperation(f.intent);
    f.store.enqueueInput(f.session.id, owner!, { ...f.intent, clientRequestId: "a", input: "one", mode: "queue" });
    f.store.enqueueInput(f.session.id, owner!, { ...f.intent, clientRequestId: "b", input: "two", mode: "queue" });
    f.store.claimQueuedInput(f.session.id, owner!);
    f.store.database.prepare("UPDATE sessions SET owner_token = ?, lease_until = 0 WHERE id = ?").run("99999999-abandoned", f.session.id);
    const restarted = openSessionStore(f.options);
    try {
      assert.equal(restarted.recoverOperations(), 1);
      assert.equal(restarted.getOperation(operation.id)?.state, "interrupted");
      assert.deepEqual(restarted.queuedInputs(f.session.id).map((item) => [item.clientRequestId, item.state]), [["a", "paused"], ["b", "paused"]]);
    } finally { restarted.close(); }
  } finally { f.cleanup(); }
});

/** A provider step that waits until the turn is stopped. */
const untilStopped = (request: ProviderRequest) => new Promise<never>((_resolve, reject) => {
  const stop = () => reject(new Error("stopped"));
  request.signal?.addEventListener("abort", stop, { once: true });
  if (request.signal?.aborted) stop();
});

test("an interrupt during a tool cancels the turn and its message starts the next one, keeping finished results", async () => {
  const started = gate(); let competing: unknown;
  const registry = new ToolRegistry();
  registry.register({ name: "work", description: "Work", inputSchema: { type: "object" }, async handler() {
    return { isError: false, content: [{ type: "text", text: "worked" }] };
  } });
  registry.register({ name: "wait", description: "Wait", inputSchema: { type: "object" }, async handler(_args, context) {
    started.open();
    await new Promise<void>((resolve) => { context.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return { isError: true, code: "aborted", content: [{ type: "text", text: "stopped" }] };
  } });
  const h = harness({ registry,
    beforeAttach: async (operation) => {
      if (operation.clientRequestId !== "now") return;
      const other = openSessionStore(h.options);
      try { other.claimSession(h.session.id); competing = "claimed"; } catch (error) { competing = error; } finally { other.close(); }
    },
    generate: async (_request, index) => index === 0 ? { text: "", finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "work", arguments: {} }, { id: "call-2", name: "wait", arguments: {} }] } : answer("done") });
  try {
    h.store.database.exec(`CREATE TEMP TABLE releases(generation INTEGER);
      CREATE TEMP TRIGGER record_release AFTER UPDATE OF owner_token ON sessions WHEN NEW.owner_token IS NULL
      BEGIN INSERT INTO releases VALUES (OLD.owner_generation); END;`);
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await started.promise;
    h.send("earlier", "queued before");
    const startedAt = Date.now();
    const interrupt = h.service.enqueue({ ...h.intent, clientRequestId: "now", input: "new direction" }, { mode: "interrupt" });
    assert.equal("queued" in interrupt && interrupt.queued.mode, "interrupt");
    assert.equal((await h.service.wait(operation.id)).state, "cancelled");
    assert.ok(Date.now() - startedAt < 2000);
    await until(() => h.row("now")?.state === "taken", "the interrupting turn");
    const next = h.store.findOperation(h.session.id, "now")!;
    assert.equal((await h.service.wait(next.id)).state, "completed");
    assert.deepEqual(lines(h.requests[1]!).slice(-5), ["assistant:", "tool:call-1", "tool:call-2", "user:new direction", "user:queued before"]);
    assert.equal(h.row("earlier")?.state, "delivered"); assert.equal(h.row("earlier")?.operationId, next.id);
    assert.ok(competing instanceof Error && /busy/.test(competing.message), String(competing));
    assert.deepEqual(h.store.database.prepare("SELECT generation FROM releases").all().map((item) => Number(item.generation)), [next.ownerGeneration]);
  } finally { await h.close(); }
});

test("two interrupts in a row cancel once and start one turn; the first is delivered after the second", async () => {
  const entered = gate();
  const h = harness({ generate: async (request, index) => { if (index === 0) { entered.open(); return untilStopped(request); } return answer("done"); } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.service.enqueue({ ...h.intent, clientRequestId: "a", input: "first interrupt" }, { mode: "interrupt" });
    h.service.enqueue({ ...h.intent, clientRequestId: "b", input: "second interrupt" }, { mode: "interrupt" });
    assert.equal((await h.service.wait(operation.id)).state, "cancelled");
    await until(() => h.row("b")?.state === "taken", "the interrupting turn");
    const next = h.store.findOperation(h.session.id, "b")!;
    assert.equal((await h.service.wait(next.id)).state, "completed");
    assert.equal(h.store.findOperation(h.session.id, "a"), undefined);
    assert.equal(h.store.listOperations(h.session.id).length, 2);
    assert.deepEqual(lines(h.requests[1]!).slice(-2), ["user:second interrupt", "user:first interrupt"]);
    assert.equal(h.row("a")?.state, "delivered");
  } finally { await h.close(); }
});

test("Send now interrupts with a waiting message and refuses one already sent", async () => {
  const entered = gate();
  const h = harness({ generate: async (request, index) => {
    if (index === 0) { entered.open(); return untilStopped(request); }
    return answer(`answer ${index}`);
  } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("a", "one"); h.send("b", "two");
    const sent = h.service.sendNow(h.session.id, h.store.findQueuedInput(h.session.id, "b")!.id);
    assert.equal("queued" in sent && sent.queued.mode, "interrupt");
    assert.equal((await h.service.wait(operation.id)).state, "cancelled");
    await until(() => h.row("b")?.state === "taken", "the interrupting turn");
    const next = h.store.findOperation(h.session.id, "b")!;
    assert.equal((await h.service.wait(next.id)).state, "completed");
    assert.deepEqual(lines(h.requests[1]!).slice(-2), ["user:two", "user:one"]);
    assert.throws(() => h.service.sendNow(h.session.id, h.store.findQueuedInput(h.session.id, "b")!.id), (error: Error & { code?: string }) => error.code === "already_sent");
    assert.throws(() => h.service.sendNow(h.session.id, h.store.findQueuedInput(h.session.id, "a")!.id), (error: Error & { code?: string }) => error.code === "already_sent");
  } finally { await h.close(); }
});

test("Send now starts a paused message as a turn when the session is idle", async () => {
  const entered = gate();
  const h = harness({ generate: async (request, index) => { if (index === 0) { entered.open(); return untilStopped(request); } return answer("done"); } });
  try {
    const { operation } = h.send("first", "do it") as { operation: SessionOperation };
    await entered.promise;
    h.send("a", "one"); h.send("b", "two");
    h.service.cancel(operation.id);
    await h.service.wait(operation.id);
    assert.deepEqual(h.store.queuedInputs(h.session.id).map((item) => item.state), ["paused", "paused"]);
    const started = h.service.sendNow(h.session.id, h.store.findQueuedInput(h.session.id, "b")!.id);
    assert.ok("operation" in started && started.operation.clientRequestId === "b");
    assert.equal((await h.service.wait(started.operation.id)).state, "completed");
    assert.equal(h.row("b")?.state, "taken"); assert.equal(h.row("a")?.state, "paused");
    assert.equal(lines(h.requests[1]!).at(-1), "user:two");
  } finally { await h.close(); }
});

test("an interrupt on an idle session is a normal send", async () => {
  const h = harness({ generate: async () => answer("done") });
  try {
    const sent = h.service.enqueue({ ...h.intent, clientRequestId: "idle", input: "hello" }, { mode: "interrupt" });
    assert.ok("operation" in sent);
    assert.equal((await h.service.wait(sent.operation.id)).state, "completed");
    assert.equal(h.row("idle"), undefined);
  } finally { await h.close(); }
});

test("a CLI turn (origin cli) commits the host's note, runs no UserPromptSubmit and leaves queued messages waiting", async () => {
  const f = fixture();
  const guard = guardHook(f.root);
  const requests: ModelMessage[][] = [];
  const provider: ProviderAdapter = { modelConfig, async generate(request) { requests.push(structuredClone([...request.messages])); return answer("noted"); } };
  const accepted = f.store.acceptOperation({ ...f.intent, clientRequestId: "cli", input: "Background command \"x\" completed (exit code 0)." });
  const owner = accepted.owner!;
  f.store.updateOperation(accepted.operation.id, owner, "starting");
  f.store.updateOperation(accepted.operation.id, owner, "running");
  const agent = createAgent({ provider, cwd: f.root, deliverQueuedInputs: true, hooks: guard.hooks,
    persistence: { store: f.store, sessionId: f.session.id, surface: "web", owner, ownership: "host", operationId: accepted.operation.id } });
  try {
    f.store.enqueueInput(f.session.id, owner, { ...f.intent, clientRequestId: "waiting", input: "later please", mode: "queue" });
    const result = await agent.run("Background command \"x\" completed (exit code 0).", undefined,
      { origin: "cli", notice: "Codex continues: Background command \"x\" completed (exit code 0)." });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(lines(requests[0]!), ["user:[Background task] Background command \"x\" completed (exit code 0)."]);
    assert.equal(f.store.findQueuedInput(f.session.id, "waiting")?.state, "queued");
    assert.deepEqual(guard.seen(), []);
    const items = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items;
    assert.deepEqual(items.filter((item) => item.kind === "user"), []);
    assert.deepEqual(items.filter((item) => item.kind === "backend_notice").map((item) => item.payload.text),
      ["Codex continues: Background command \"x\" completed (exit code 0)."]);
    assert.equal(f.store.getSession(f.session.id)?.title, "New session", "a note does not name the chat");
  } finally { await agent.close(); f.store.releaseSession(f.session.id, owner); f.cleanup(); }
});
