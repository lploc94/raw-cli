import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTerminalHistory } from "../src/terminal/history.js";
import { projectToolCall, projectToolResult } from "../src/sessions/visible.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import type { HistoryItem } from "../src/sessions/store.js";

const item = (kind: string, payload: Record<string, unknown>): HistoryItem => ({
  sessionId: "id", sequence: 1, createdAt: 1, kind, payload, status: "complete",
});

test("history uses current theme for saved assistant Markdown and path-tagged read code", () => {
  const result = projectToolResult("read_file", "builtin/read_file", { isError: false,
    content: [{ type: "json", value: { results: [{ index: 0, status: "ok", path: "src/a.ts", text: "const x = 1;" }] } }],
  });
  const dark = resolveUiOptions({ color: "always", theme: "dark" });
  const light = resolveUiOptions({ color: "always", theme: "light" });
  const caps = terminalCapabilities(true, { TERM: "xterm" }, dark);
  const saved = item("tool_result", { display: { ...result, id: "call" } });
  const a = renderTerminalHistory(saved, dark, caps, 80);
  const b = renderTerminalHistory(saved, light, caps, 80);
  assert.match(a, /const/);
  assert.match(a, /\u001b\[/);
  assert.notEqual(a, b);
  assert.match(renderTerminalHistory(item("assistant", { text: "# Result\n\n```ts\nconst x = 1;\n```" }), dark, caps, 80), /Result[\s\S]*const/);
});

test("orphan result, rejected call and ACP-origin update remain readable", () => {
  const ui = resolveUiOptions({ icons: "ascii", color: "never" });
  const caps = terminalCapabilities(false, { TERM: "dumb" }, ui);
  const call = projectToolCall("bash", "builtin/bash", { commands: [{ command: "rm -rf scratch" }] }, false);
  assert.match(renderTerminalHistory(item("tool_call", { display: { ...call, id: "call" } }), ui, caps, 40).replace(/\n/g, ""), /rm -rf scratch/);
  const result = projectToolResult("bash", "builtin/bash", { isError: true, content: [{ type: "text", text: "denied" }], code: "denied" });
  assert.match(renderTerminalHistory(item("tool_result", { display: { ...result, id: "call" } }), ui, caps, 40), /\[error\] bash[\s\S]*denied/);
  assert.match(renderTerminalHistory(item("tool_call", { update: { sessionUpdate: "tool_call", name: "external" } }), ui, caps, 40), /external/);
});
