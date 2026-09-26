import assert from "node:assert/strict";
import { test } from "node:test";
import { textWidth, wrapText } from "../src/terminal/layout.js";
import { icon, paint } from "../src/terminal/theme.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import { TerminalWriter } from "../src/terminal/writer.js";
import { Writable } from "node:stream";
import { terminalScreen } from "./fixtures/terminal-screen.js";

test("terminal widths count cells and wrapping retains readable source", () => {
  assert.equal(textWidth("Tiếng Việt"), 10);
  assert.equal(textWidth("界"), 2);
  assert.equal(textWidth("e\u0301"), 1);
  assert.equal(textWidth("\u001b[31m界\u001b[0m"), 2);
  for (const width of [4, 40, 80, 120]) {
    const lines = wrapText("đường/dẫn/rất/dài/界界 code", width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => textWidth(line) <= width));
    assert.equal(lines.join(""), "đường/dẫn/rất/dài/界界 code");
  }
});

test("semantic colors and ASCII icons preserve role when colors are disabled", () => {
  const ui = resolveUiOptions({ icons: "ascii", color: "never", palette: { error: "red" } });
  const plain = terminalCapabilities(true, { TERM: "xterm" }, ui);
  assert.equal(paint("error", "Failed", ui, plain), "Failed");
  assert.equal(icon("failure", ui, plain), "[error]");
  const coloredUi = resolveUiOptions({ color: "always" });
  const colored = terminalCapabilities(true, { TERM: "xterm" }, coloredUi);
  assert.match(paint("error", "Failed", coloredUi, colored), /\u001b\[[0-9;]+mFailed\u001b\[0m/);
  assert.equal(icon("success", coloredUi, colored), "✓");
});

test("writer clears a transient row and disposes its timer before committed text", () => {
  const bytes: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { bytes.push(String(chunk)); callback(); } });
  let callbacks = new Map<number, () => void>();
  let next = 0;
  const clock = {
    interval: ((callback: () => void) => { callbacks.set(++next, callback); return next as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval,
    clear: ((timer: ReturnType<typeof setInterval>) => { callbacks.delete(timer as unknown as number); }) as typeof clearInterval,
  };
  const writer = new TerminalWriter(output, true, clock);
  writer.activity("Reading files");
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value?.();
  writer.write("Done\n");
  assert.equal(callbacks.size, 0);
  assert.match(bytes.join(""), /\r\u001b\[2KDone\n$/);
  writer.finish();
  assert.equal(callbacks.size, 0);
  assert.deepEqual(terminalScreen(bytes.join("")), ["Done", ""]);
  const plain: string[] = [];
  const plainWriter = new TerminalWriter(new Writable({ write(chunk, _encoding, callback) {
    plain.push(String(chunk)); callback();
  } }), false, clock);
  plainWriter.activity("Reading files");
  plainWriter.finish();
  assert.equal(plain.join(""), "Reading files\n");
});
