import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolStart, formatToolResult } from "../src/terminal/tools.js";
import { projectToolCall, projectToolResult } from "../src/sessions/visible.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";

const caps = terminalCapabilities(true, { TERM: "xterm" }, resolveUiOptions({ color: "always" }));
const strip = (text: string) => text.replace(/\u001b\[[0-9;]+m/g, "");

test("builtin actions have distinct type icons and status is independent", () => {
  const ui = resolveUiOptions({ color: "always" });
  const read = projectToolCall("read_file", "builtin/read_file", { files: [{ path: "src/index.ts" }] }, true);
  const command = projectToolCall("bash", "builtin/bash", { commands: [{ command: "pwd" }] }, true);
  assert.match(strip(formatToolStart(read, ui, caps, 80)), /↳ read_file.*src\/index.ts/);
  assert.match(strip(formatToolStart(command, ui, caps, 80)), /\$ bash.*pwd/);
  const failed = projectToolResult("bash", "builtin/bash", { isError: true,
    content: [{ type: "text", text: "permission denied" }], exitCode: 13 }, 120);
  const result = strip(formatToolResult(failed, ui, caps, 80));
  assert.match(result, /✗ bash.*exit 13.*120ms/);
  assert.match(result, /permission denied/);
});

test("normal and compact density preserve failed batch states and generic tool identity", () => {
  const value = { results: [{ index: 0, status: "ok", stdout: "one" }, { index: 1, status: "error", error: "failed" }] };
  const result = projectToolResult("bash", "builtin/bash", { isError: false, content: [{ type: "json", value }] });
  for (const density of ["compact", "normal", "verbose"] as const) {
    const ui = resolveUiOptions({ density, color: "always" });
    const rendered = strip(formatToolResult(result, ui, caps, 40));
    assert.match(rendered, /0:ok/);
    assert.match(rendered, /1:error/);
    assert.match(rendered, /✗ bash/);
  }
  const custom = projectToolCall("read_file", "mcp/server/read_file", { query: "test" }, true);
  assert.match(strip(formatToolStart(custom, resolveUiOptions({}), caps, 80)), /↗ read_file.*query/);
  assert.match(strip(formatToolStart(custom, resolveUiOptions({ density: "verbose" }), caps, 80)), /mcp\/server\/read_file/);
});

test("tool-provided control bytes cannot erase terminal output", () => {
  const ui = resolveUiOptions({ color: "always" });
  const call = projectToolCall("bash", "builtin/bash", { commands: [{ command: "printf '\u001b[2J'" }] }, true);
  const result = projectToolResult("bash", "builtin/bash", { isError: false, content: [{ type: "text", text: "\u001b[2Jdanger" }] });
  const shown = formatToolStart(call, ui, caps, 80) + formatToolResult(result, ui, caps, 80);
  assert.doesNotMatch(shown, /\u001b\[2J/);
  assert.match(shown, /␛\[2Jdanger/);
});
