#!/usr/bin/env node
// Local renderer gallery: fixed records, no config, provider, session store, or network.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.env.RAW_PREVIEW_TSX !== "1") {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, RAW_PREVIEW_TSX: "1" } });
  process.exit(child.status ?? 1);
}

const { resolveUiOptions, terminalCapabilities } = await import("../src/terminal/options.ts");
const { icon, paint } = await import("../src/terminal/theme.ts");
const { renderMarkdown } = await import("../src/terminal/markdown.ts");
const { formatToolStart, formatToolResult } = await import("../src/terminal/tools.ts");
const { formatTurnFooter } = await import("../src/terminal/footer.ts");
const { renderTerminalHistory } = await import("../src/terminal/history.ts");
const { projectToolCall, projectToolResult } = await import("../src/sessions/visible.ts");

const options = { width: 80, theme: "terminal", icons: "unicode", display: "normal" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key === "--width" && /^(40|80|120)$/.test(value ?? "")) options.width = Number(value);
  else if (key === "--theme" && ["light", "dark", "terminal"].includes(value)) options.theme = value;
  else if (key === "--icons" && ["ascii", "unicode"].includes(value)) options.icons = value;
  else if (key === "--display" && ["compact", "normal", "verbose"].includes(value)) options.display = value;
  else { process.stderr.write("usage: node scripts/preview-terminal.mjs --width 40|80|120 --theme light|dark|terminal --icons ascii|unicode [--display compact|normal|verbose]\n"); process.exit(2); }
}

const ui = resolveUiOptions({ density: options.display, theme: options.theme, icons: options.icons });
const caps = terminalCapabilities(Boolean(process.stdout.isTTY), { ...process.env, TERM: process.env.TERM ?? "xterm" }, ui);
const width = options.width;
const divider = `${"─".repeat(Math.min(width, 60))}\n`;
const write = (value) => process.stdout.write(value);
const sessionId = "11111111-2222-4333-8444-555555555555";
const call = { ...projectToolCall("read_file", "builtin/read_file", { files: [{ path: "src/example.ts" }] }, true), id: "read-1" };
const result = { ...projectToolResult("read_file", "builtin/read_file", { isError: false, content: [{
  type: "json", value: { results: [{ index: 0, status: "ok", path: "src/example.ts", text: "export const answer = 42;\nconsole.log(answer);\n" }] },
}] }, 38), id: "read-1" };
const denied = { ...projectToolCall("bash", "builtin/bash", { commands: [{ command: "rm -rf scratch" }] }, false), id: "bash-2" };
const stats = { requests: 2, inputTokensKnown: 2400, inputCoverage: 2, outputTokensKnown: 180,
  outputCoverage: 2, cacheReadTokensKnown: 600, cacheReadCoverage: 2, cacheWriteTokensKnown: 0,
  cacheWriteCoverage: 0, cacheRatioCoverage: 2, cacheReadRatio: 0.25 };

write(`${paint("accent", `${icon("brand", ui, caps)} raw`, ui, caps)} · agent raw · model fixture\n/project\n\n`);
write(`${paint("accent", icon("user", ui, caps), ui, caps)} Find the answer in src/example.ts\n`);
write(`${paint("thinking", `${icon("thinking", ui, caps)} Thinking…`, ui, caps)}\n`);
write(formatToolStart(call, ui, caps, width));
write(formatToolResult(result, ui, caps, width));
write(`${paint("accent", icon("assistant", ui, caps), ui, caps)} ${renderMarkdown("# Found\n\nThe answer is **42** in `src/example.ts`.\n\n```ts\nexport const answer = 42;\n```", ui, caps, width - 2)}`);
write(formatTurnFooter({ status: "completed", elapsedMs: 1240, startedToolCalls: 1, notRunToolCalls: 0,
  stats, contextTokens: 3400, contextWindow: 8192, inputBudget: 6700, sessionId, resumable: true, ui, caps }));
write(`\n${divider}${paint("accent", "Approval and failure", ui, caps)}\n`);
write(`${paint("warning", `${icon("attention", ui, caps)} Allow bash?`, ui, caps)}\n  [y/N] n\n`);
write(formatToolStart(denied, ui, caps, width));
write(formatToolResult({ ...projectToolResult("bash", "builtin/bash", {
  isError: true, code: "approval_denied", content: [{ type: "text", text: "Approval denied by user" }],
}, 2), id: "bash-2" }, ui, caps, width));
write(formatTurnFooter({ status: "error", code: "approval_denied", elapsedMs: 55, startedToolCalls: 0, notRunToolCalls: 1,
  stats, contextTokens: 3400, contextWindow: 8192, inputBudget: 6700, sessionId, resumable: true, ui, caps }));
write(`\n${divider}${paint("accent", "Saved history", ui, caps)}\n`);
write(renderTerminalHistory({ sessionId, sequence: 4, createdAt: 0, kind: "tool_result", status: "complete",
  payload: { display: result } }, ui, caps, width));
