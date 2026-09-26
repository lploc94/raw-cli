import assert from "node:assert/strict";
import test from "node:test";
import { projectHistoryItem } from "../src/sessions/view.js";
import type { HistoryItem } from "../src/sessions/store.js";
import { projectToolResult } from "../src/sessions/visible.js";

const item = (kind: string, payload: Record<string, unknown>, sequence = 1): HistoryItem =>
  ({ sessionId: "test", sequence, kind, payload, status: "complete", createdAt: 1000 });

test("mixed CLI/ACP history projects stable text and tool identities without mutation", () => {
  const source = item("assistant", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } });
  const original = structuredClone(source);
  assert.equal(projectHistoryItem(source).text, "answer");
  assert.equal(projectHistoryItem(source).id, "history:1");
  assert.deepEqual(source, original);
  const call = projectHistoryItem(item("tool_call", { update: { sessionUpdate: "tool_call", toolCallId: "c",
    name: "custom", rawInput: { n: 3 }, status: "pending" } }));
  assert.equal(call.callId, "c"); assert.equal(call.toolCall?.started, false);
  const result = projectHistoryItem(item("tool_result", { display: { ...projectToolResult("custom", undefined,
    { isError: true, code: "outcome_unknown", content: [{ type: "text", text: "inspect effects" }] }), id: "c" } }));
  assert.equal(result.toolState, "outcome_unknown");
  assert.equal(result.callId, "c");
});

test("previews distinguish display abbreviation from tool truncation and do not invent full output", () => {
  const display = projectToolResult("bash", "builtin/bash", { isError: false, content: [{ type: "text", text: "line\n".repeat(100) }] });
  const view = projectHistoryItem(item("tool_result", { display }));
  assert.equal(view.toolResult?.truncated, false);
  assert.equal(view.previewOnly, true);
  assert.equal(view.previewAbbreviated, true);
  assert.equal(Object.hasOwn(view, "fullOutput"), false);
});
