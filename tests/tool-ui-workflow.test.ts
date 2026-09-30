import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "../src/sessions/store.js";
import type { InteractionRequest } from "../src/interactions/contract.js";
import type { CommandRecord } from "../src/processes/presentation.js";
import type { ProcessControl } from "../src/processes/controls.js";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { workflowScenario, workflowAnswer, workflowCall, workflowPatch, installWorkflowDiagram } from "./fixtures/tool-ui-workflow.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 2500; n++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("workflow state did not settle");
}
test("built tools coexist across turns, answer/turn/control retries and SSE reconnect without side-effect replay", async () => {
  const f = await dashboardFixture(workflowScenario);
  installWorkflowDiagram(f.env);
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const turn = (clientRequestId: string, input: string) => f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", { clientRequestId, kind: "turn", agent: "raw", input });
    const first = await turn("first", "ask and start");
    const pending = await until(() => f.json<{ interactions: InteractionRequest[] }>(`/sessions/${session.id}`), s => s.interactions.length === 1);
    const question = pending.interactions[0]!;
    const response = { requestId: question.identity.requestId, expectedRevision: question.revision, idempotencyKey: "answer-once", response: "submit", answers: { choice: workflowAnswer } };
    const path = `/sessions/${session.id}/interactions/${question.identity.requestId}/responses`;
    const ack = await f.json(path, "POST", response);
    assert.deepEqual(await f.json(path, "POST", response), ack);
    assert.equal((await f.wait(first.id)).state, "completed");
    assert.equal((await turn("first", "ask and start")).id, first.id);
    const rows = await f.json<{ items: CommandRecord[] }>(`/sessions/${session.id}/commands`);
    assert.equal(rows.items.length, 1);
    const job = rows.items[0]!;
    assert.equal(job.kind, "background"); assert.equal(job.state, "running");
    assert.match(JSON.stringify(f.provider.requests[1]!.body), /Đã chọn/);
    const before = await f.json<{ items: unknown[] }>(`/sessions/${session.id}/history?limit=100`);
    const second = await turn("second", "patch and diagram");
    assert.equal((await f.wait(second.id)).state, "completed");
    assert.equal((await turn("second", "patch and diagram")).id, second.id);
    assert.equal(readFileSync(join(f.root, "workflow.txt"), "utf8"), "written exactly once 雪\n");
    const after = await f.json<{ items: unknown[] }>(`/sessions/${session.id}/history?limit=100`);
    assert.deepEqual(after.items.slice(0, before.items.length), before.items);
    const panels = await f.json<{ items: unknown[] }>(`/sessions/${session.id}/panels`);
    assert.match(JSON.stringify(panels), /files_changed/); assert.match(JSON.stringify(panels), /Workflow diagram/);
    assert.match(JSON.stringify(panels), /"status":"done"/);
    const stream = await eventStream(f.server, session.id);
    const snapshot = await stream.next(); stream.close();
    assert.equal(snapshot.type, "snapshot");
    const reconnect = await eventStream(f.server, session.id, snapshot.id);
    reconnect.close();
    assert.equal((await f.json<{ items: CommandRecord[] }>(`/sessions/${session.id}/commands`)).items[0]!.id, job.id);
    const third = await turn("held", "keep model pending");
    await until(async () => f.provider.requests.length, count => count === 9);
    assert.equal(f.server.context.store!.sessionIsBusy(session.id), true);
    const controlPath = `/sessions/${session.id}/commands/${job.id}`;
    const stop = await f.json<ProcessControl>(controlPath + "/stop", "POST", { clientRequestId: "stop-once" });
    assert.equal((await f.json<ProcessControl>(controlPath + "/stop", "POST", { clientRequestId: "stop-once" })).id, stop.id);
    assert.equal((await until(() => f.json<ProcessControl>(controlPath + `/controls/${stop.id}`), c => c.state !== "running")).state, "completed");
    assert.equal(f.provider.requests.length, 9);
    assert.equal(f.server.context.store!.sessionIsBusy(session.id), true);
    const final = await f.json<{ items: unknown[] }>(`/sessions/${session.id}/history?limit=100`);
    // Pending third turn adds its prompt; native Stop must not add model/tool messages.
    assert.equal(final.items.length, after.items.length + 1);
    assert.equal((await f.json<{ items: CommandRecord[] }>(`/sessions/${session.id}/commands`)).items[0]!.state, "stopped");
    await f.json(`/operations/${third.id}/cancel`, "POST", {});
    assert.equal((await f.wait(third.id)).state, "cancelled");
    assert.equal((await f.api(path, "POST", { ...response, idempotencyKey: "different" })).status, 409);
  } finally { await f.close(); }
});

test("a killed built dashboard recovers process/question ownership without reviving waits or replaying a committed patch", async () => {
  const f = await dashboardFixture({ agent: { ...workflowScenario.agent, tools: { ...workflowScenario.agent.tools, rules: [{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }] } }, responses: [
    workflowCall("start", "process", { action: "start", command: "sleep 2", timeout_ms: 5000 }),
    workflowCall("patch", "write_file", { patch: workflowPatch }),
    { frames: [openAiFrame({ content: "committed" }, "stop"), openAiDone] },
    workflowCall("pending", "ask_user", { questions: [{ id: "q", label: "Crash question", kind: "text" }] }),
  ] });
  installWorkflowDiagram(f.env);
  const child = fork(join(process.cwd(), "tests/fixtures/tool-ui-host-worker.mjs"), [f.root, f.configPath], { env: f.env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.setEncoding("utf8").on("data", part => { stderr += part; });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message as { url: string; token: string }),
      exited.then(() => { throw new Error("built dashboard exited: " + stderr); }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host startup timeout")), 10000).unref()),
    ]);
    const api = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(ready.url + "/api" + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value as T;
    };
    const session = await api<SessionSummary>("/sessions", { cwd: f.root, agent: "raw" });
    const firstBody = { clientRequestId: "committed", kind: "turn", agent: "raw", input: "start and patch" };
    const first = await api<{ id: string }>(`/sessions/${session.id}/operations`, firstBody);
    assert.equal((await f.wait(first.id)).state, "completed");
    const secondBody = { clientRequestId: "crash", kind: "turn", agent: "raw", input: "ask" };
    const second = await api<{ id: string }>(`/sessions/${session.id}/operations`, secondBody);
    const pending = await until(() => api<{ interactions: InteractionRequest[] }>(`/sessions/${session.id}`), s => s.interactions.length === 1);
    const question = pending.interactions[0]!;
    const job = (await api<{ items: CommandRecord[] }>(`/sessions/${session.id}/commands`)).items[0]!;
    const stopPath = `/sessions/${session.id}/commands/${job.id}`;
    const stop = await api<ProcessControl>(stopPath + "/stop", { clientRequestId: "crashed-stop" });
    await until(() => api<{ approvals: unknown[] }>(`/sessions/${session.id}`), s => s.approvals.length === 1);
    child.kill("SIGKILL"); await exited;
    const recoveredStop = await f.json<ProcessControl>(stopPath + `/controls/${stop.id}`);
    assert.equal(recoveredStop.state, "interrupted");
    assert.equal((await f.json<ProcessControl>(stopPath + "/stop", "POST", { clientRequestId: "crashed-stop" })).id, stop.id);
    // Session ownership remains fenced until its 15-second lease expires.
    const recovered = await until(() => f.json<InteractionRequest>(`/sessions/${session.id}/interactions/${question.identity.requestId}`), q => q.state !== "pending");
    assert.equal(recovered.state, "interrupted");
    assert.equal((await f.json<{ state: string }>(`/operations/${second.id}`)).state, "interrupted");
    const jobs = await f.json<{ items: CommandRecord[] }>(`/sessions/${session.id}/commands`);
    assert.equal(jobs.items.length, 1); assert.equal(jobs.items[0]!.state, "lost");
    assert.equal((await f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", firstBody)).id, first.id);
    assert.equal((await f.json<{ id: string }>(`/sessions/${session.id}/operations`, "POST", secondBody)).id, second.id);
    assert.equal((await f.api(`/sessions/${session.id}/interactions/${question.identity.requestId}/responses`, "POST", { requestId: question.identity.requestId, expectedRevision: question.revision, idempotencyKey: "late", response: "submit", answers: { q: "late" } })).status, 409);
    assert.equal(readFileSync(join(f.root, "workflow.txt"), "utf8"), "written exactly once 雪\n");
    assert.equal(f.provider.requests.length, 4);
    // A crashed host cannot reclaim OS children. This fixture's child exits by itself.
    await new Promise(resolve => setTimeout(resolve, 2100));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; await f.close(); }
});
