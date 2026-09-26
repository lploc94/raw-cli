import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseCliArgs, readConfigDocument } from "../src/config.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";

function config(ui: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "raw-ui-")), "raw.json");
  writeFileSync(path, JSON.stringify({ ui, default_agent: "raw", models: { local: {
    provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
  } }, agents: { raw: { model: "local", tools: { use: [] } } } }));
  return path;
}

test("root ui is strict, host-only, and flags override document values", async () => {
  const path = config({ density: "compact", color: "never", palette: { accent: "cyan" } });
  const flags = parseCliArgs(["--config", path, "--display", "verbose", "--reasoning", "hidden",
    "--color", "always", "--icons", "ascii", "--theme", "light", "hello"]).flags;
  const runtime = await loadConfig({ flags, env: {}, requireModel: true });
  assert.deepEqual(runtime.ui, {
    density: "verbose", reasoning: "hidden", color: "always", icons: "ascii", theme: "light",
    palette: { accent: "cyan" },
  });
  assert.equal(Object.isFrozen(runtime.ui), true);
  assert.equal(runtime.modelConfig?.model, "fixture");
  const plain = await loadConfig({ configPath: path, env: {}, requireModel: true });
  assert.equal(plain.ui.reasoning, "summary");
  assert.equal(resolveUiOptions({ density: "verbose" }).reasoning, "full");
  assert.equal(readConfigDocument({ configPath: path }).data.ui !== undefined, true);
});

test("UI validation rejects unknown fields, roles, colors and invalid flag values", async () => {
  for (const ui of [{ density: "dense" }, { color: null }, { palette: { secret: "red" } },
    { palette: { accent: "\u001b[31m" } }, { theme: 7 }, { reasoning: "raw" }]) {
    const path = config(ui);
    assert.throws(() => readConfigDocument({ configPath: path }), /ui|palette|density|color|theme|reasoning/i);
  }
  for (const args of [["--display", "bad"], ["--color"], ["--icons", "fancy"],
    ["--theme", "dark", "--theme", "light"]]) {
    assert.throws(() => parseCliArgs([...args, "task"]));
  }
});

test("TTY capability is per stream; redirected always, NO_COLOR and dumb never emit ANSI", () => {
  const ui = resolveUiOptions({ color: "always", icons: "unicode" });
  assert.equal(terminalCapabilities(false, { TERM: "xterm" }, ui).ansi, false);
  assert.equal(terminalCapabilities(true, { TERM: "dumb" }, ui).ansi, false);
  assert.equal(terminalCapabilities(true, { TERM: "xterm" }, ui).ansi, true);
  assert.equal(terminalCapabilities(true, { TERM: "xterm", NO_COLOR: "1" }, resolveUiOptions({})).ansi, false);
  assert.equal(terminalCapabilities(true, { TERM: "xterm", NO_COLOR: "1" }, ui).ansi, true);
  assert.equal(terminalCapabilities(false, { TERM: "xterm" }, resolveUiOptions({})).unicode, false);
});
