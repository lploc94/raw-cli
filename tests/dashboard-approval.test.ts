import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";

test("conditional Bash approval gates only matching arguments and first answer wins across tabs", async () => {
  const call = (id: string, command: string) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function",
    function: { name: "bash", arguments: JSON.stringify({ commands: [{ command }] }) } }] }, "tool_calls"), openAiDone] });
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"], rules: [
    { match: "builtin/bash", effect: "ask", when: { source: "arguments", any: "commands[*].command", regex: "^rm\\b" } },
  ] } }, responses: [call("safe", "printf safe"), call("gate", "rm not-present"), { frames: [openAiFrame({ content: "denied safely" }, "stop"), openAiDone] }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "ask", kind: "turn", agent: "raw", input: "test the policy" });
    let approval: { id: string; operationId: string; callId: string; deadline: number } | undefined;
    for (let index = 0; index < 1000; index++) {
      const activity = await f.json<{ approvals: Array<NonNullable<typeof approval>> }>("/activity");
      assert.doesNotMatch(JSON.stringify(activity), /rm not-present|test the policy/);
      approval = activity.approvals[0]; if (approval) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(approval); assert.equal(approval.callId, "gate");
    const again = await f.json<{ approvals: Array<{ deadline: number }> }>("/activity"); assert.equal(again.approvals[0]?.deadline, approval.deadline);
    const payload = { operationId: op.id, callId: "gate", allow: false };
    assert.equal((await f.api(`/permissions/${approval.id}`, "POST", { ...payload, callId: "wrong" })).status, 409);
    const results = await Promise.all([1, 2].map(() => f.api(`/permissions/${approval!.id}`, "POST", payload)));
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
    assert.equal((await f.wait(op.id)).state, "completed");
    const history = await f.json<{ items: Array<{ toolResult?: { code?: string }; toolCall?: { name: string } }> }>(`/sessions/${session.id}/history`);
    assert.ok(history.items.some((item) => item.toolResult?.code === "approval_denied"));
    assert.equal(history.items.filter((item) => item.toolCall?.name === "bash").length, 2);
  } finally { await f.close(); }
});

for (const action of ["expire", "cancel"] as const) test(`pending approval can ${action} without a connected subscriber or tool effect`, async () => {
  const f = await dashboardFixture({ agent: { request_timeout_ms: 500, tools: { use: ["builtin/bash"], rules: [{ match: "builtin/bash", effect: "ask" }] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "pending", type: "function", function: { name: "bash", arguments: '{"commands":[{"command":"printf forbidden"}]}' } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "not executed" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: action, kind: "turn", agent: "raw", input: "go" });
    let pending: { id: string; callId: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = (await f.json<{ approvals: Array<{ id: string; callId: string }> }>("/activity")).approvals[0];
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(pending);
    if (action === "cancel") await f.json(`/operations/${op.id}/cancel`, "POST");
    const terminal = await f.wait(op.id); assert.equal(terminal.state, action === "cancel" ? "cancelled" : "completed");
    assert.equal((await f.api(`/permissions/${pending.id}`, "POST", { operationId: op.id, callId: pending.callId, allow: true })).status, 409);
    const history = await f.json<{ items: Array<{ toolResult?: { code?: string; segments: unknown[] } }> }>(`/sessions/${session.id}/history`);
    assert.ok(history.items.some((item) => item.toolResult?.code === (action === "cancel" ? "aborted" : "approval_denied")));
  } finally { await f.close(); }
});
