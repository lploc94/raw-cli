import assert from "node:assert/strict";
import test from "node:test";
import { terminalInteractionAdapter } from "../src/interactions/terminal.js";
import type { InteractionRequest } from "../src/interactions/contract.js";
import { prepareForm } from "../src/panels/forms.js";
const fields = [
  { id: "text", label: "Text", kind: "text" as const, required: true, multiline: true, max_bytes: 30 },
  { id: "pick", label: "Pick", kind: "multi_select" as const, required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], max_selected: 2 },
];
const request = { identity: { requestId: "request" }, revision: 1, document: { title: "Questions" }, form: prepareForm(fields, 8192) } as InteractionRequest;
function adapter(input: Array<string | undefined>) {
  const output: string[] = [];
  return { output, run: terminalInteractionAdapter({ mark: () => 0, nextAfter: async () => input.shift() }, text => output.push(text)) };
}
test("terminal adapter validates multiline and stable selections before submitting the original request", async () => {
  const fixture = adapter(["雪", '"quoted"', ".", "3", "2,1"]);
  const result = await fixture.run(request, new AbortController().signal);
  assert.equal(result.response, "submit");
  if (result.response === "submit") assert.deepEqual(result.answers, { text: '雪\n"quoted"', pick: ["a", "b"] });
  assert.equal(result.requestId, "request");
  assert.ok(fixture.output.some(text => text.includes("unknown option")));
});
test("terminal adapter rejects oversized multiline input and retries within its effective limit", async () => {
  const fixture = adapter(["x".repeat(31), ".", "ok", ".", "1"]);
  const result = await fixture.run(request, new AbortController().signal);
  assert.equal(result.response, "submit");
  if (result.response === "submit") assert.deepEqual(result.answers, { text: "ok", pick: ["a"] });
  assert.ok(fixture.output.some(text => text.includes("byte limit")));
});
test("terminal adapter cancels on command, EOF and aborted input", async () => {
  for (const input of [["/cancel"], [undefined]]) assert.equal((await adapter(input).run(request, new AbortController().signal)).response, "cancel");
  const controller = new AbortController(); controller.abort();
  assert.equal((await adapter([]).run(request, controller.signal)).response, "cancel");
});

import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcpClient } from "../src/acp/client.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
const askCall = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "ask", type: "function", function: {
  name: "ask_user", arguments: JSON.stringify({ questions: [{ id: "q", label: "Your answer", kind: "text" }] }),
} }] }, "tool_calls"), openAiDone] };
const done = { frames: [openAiFrame({ content: "received" }, "stop"), openAiDone] };
for (const mode of ["answered", "unavailable", "malformed"] as const) test(`ACP Ask ${mode} uses negotiated interaction capability independently of permissions`, async () => {
  const fixture = await dashboardFixture({ agent: { tools: { use: ["builtin/ask_user"] } }, responses: [askCall, done] });
  let permissions = 0; let questions = 0;
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", fixture.configPath], env: fixture.env,
    onPermission: () => { permissions++; return { outcome: { outcome: "selected", optionId: "allow" } }; },
    ...(mode === "unavailable" ? {} : { onInteraction: async (request: InteractionRequest) => {
      questions++; return { requestId: request.identity.requestId, expectedRevision: request.revision, idempotencyKey: randomUUID(),
        response: "submit" as const, answers: mode === "malformed" ? { alien: "bad" } : { q: "雪\n\"answer\"" } };
    } }),
  });
  try {
    const session = await parent.newSession(fixture.root);
    assert.equal((await parent.prompt(session, "ask me")).stopReason, "end_turn");
    assert.equal(permissions, 0); assert.equal(questions, mode === "unavailable" ? 0 : 1);
    const body = fixture.provider.requests[1]!.body as { messages: Array<{ role: string; content: string }> };
    const result = body.messages.find(message => message.role === "tool")!.content;
    if (mode === "answered") assert.deepEqual(JSON.parse(result), { status: "answered", answers: { q: "雪\n\"answer\"" } });
    else if (mode === "malformed") assert.deepEqual(JSON.parse(result), { status: "cancelled" });
    else assert.match(result, /interaction_unavailable/);
  } finally { await parent.close(); await fixture.close(); }
});

test("ACP disconnect aborts a pending interaction callback and reaps the daemon", async () => {
  const fixture = await dashboardFixture({ agent: { tools: { use: ["builtin/ask_user"] } }, responses: [askCall] });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let aborted!: () => void; const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const parent = await createAcpClient({ command: process.execPath,
    args: ["--import", "tsx", "bin/raw.ts", "--acp", "--stdio", "--config", fixture.configPath], env: fixture.env,
    onInteraction: async (_request, signal) => { signal.addEventListener("abort", aborted, { once: true }); entered(); return new Promise<never>(() => {}); },
  });
  try {
    const session = await parent.newSession(fixture.root);
    const pending = parent.prompt(session, "ask me"); pending.catch(() => {});
    await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("question timeout")), 10000).unref())]);
    parent.connection.close();
    await Promise.race([cancelled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 10000).unref())]);
  } finally { await parent.close(); await fixture.close(); }
  assert.throws(() => process.kill(parent.pid!, 0));
});

test("selected Ask works on dashboard while its operation remains busy", async () => {
  const fixture = await dashboardFixture({ agent: { tools: { use: ["builtin/ask_user"] } }, responses: [askCall, done] });
  try {
    const session = await fixture.json<{ id: string }>("/sessions", "POST", {});
    const op = await fixture.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "ask", kind: "turn", agent: "raw", input: "ask me" });
    let pending: InteractionRequest | undefined;
    for (let i = 0; i < 500 && !pending; i++) {
      const snapshot = await fixture.json<{ interactions: InteractionRequest[] }>(`/sessions/${session.id}`);
      pending = snapshot.interactions.find(item => item.state === "pending");
      if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pending);
    await fixture.json(`/sessions/${session.id}/interactions/${pending.identity.requestId}/responses`, "POST", {
      requestId: pending.identity.requestId, expectedRevision: pending.revision, idempotencyKey: randomUUID(), response: "submit", answers: { q: "dashboard answer" },
    });
    assert.equal((await fixture.wait(op.id)).state, "completed");
    assert.match(JSON.stringify(fixture.provider.requests[1]!.body), /dashboard answer/);
  } finally { await fixture.close(); }
});

for (const mode of ["answered", "cancelled", "headless"] as const) test(`CLI selected Ask ${mode} through the real input surface`, async () => {
  const fixture = await dashboardFixture({ agent: { tools: { use: ["builtin/ask_user"] } }, responses: [askCall, done] });
  const args = ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), "--config", fixture.configPath, "-y", "ask me"];
  const child = mode === "headless" ? spawn(process.execPath, args, { cwd: fixture.root, env: fixture.env }) :
    spawn("python3", [join(process.cwd(), "tests/fixtures/pty-bridge.py"), process.execPath, ...args], { cwd: fixture.root, env: fixture.env });
  let output = ""; child.stdout.on("data", part => { output += String(part); }); child.stderr.on("data", part => { output += String(part); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  try {
    if (mode !== "headless") {
      for (let i = 0; i < 500 && !output.includes("Maximum"); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(output, /Maximum/);
      child.stdin.write(mode === "cancelled" ? "/cancel\n" : "terminal answer\n");
    } else child.stdin.end();
    assert.equal(await exited, 0, output);
    const body = fixture.provider.requests[1]!.body as { messages: Array<{ role: string; content: string }> };
    const result = body.messages.find(message => message.role === "tool")!.content;
    if (mode === "answered") assert.deepEqual(JSON.parse(result), { status: "answered", answers: { q: "terminal answer" } });
    else if (mode === "cancelled") assert.deepEqual(JSON.parse(result), { status: "cancelled" });
    else assert.match(result, /interaction_unavailable/);
  } finally { clearTimeout(timeout); child.kill("SIGTERM"); await exited; await fixture.close(); }
});
