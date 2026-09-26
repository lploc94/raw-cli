import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightCode, languageForPath } from "../src/terminal/highlight.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";

const ui = resolveUiOptions({ color: "always", theme: "dark" });
const ansi = terminalCapabilities(true, { TERM: "xterm" }, ui);
const plain = terminalCapabilities(false, { TERM: "dumb" }, ui);

test("code highlighting distinguishes syntax scopes and preserves source", () => {
  const source = 'const answer: number = 42; // note\nconsole.log("ok");';
  const rendered = highlightCode(source, "typescript", ui, ansi);
  assert.match(rendered, /\u001b\[/);
  assert.ok(new Set([...rendered.matchAll(/\u001b\[(\d+)m/g)].map((match) => match[1])).size >= 3);
  assert.equal(rendered.replace(/\u001b\[[0-9;]+m/g, ""), source);
  assert.equal(highlightCode(source, "typescript", ui, plain), source);
});

test("known file extensions select grammars and unknown labels remain plain", () => {
  for (const [path, expected] of [["a.tsx", "typescript"], ["b.py", "python"], ["c.sh", "bash"],
    ["data.jsonc", "json"], ["changes.diff", "diff"], ["main.rs", "rust"]] as const) {
    assert.equal(languageForPath(path), expected);
  }
  assert.equal(languageForPath("blob.unknown"), undefined);
  assert.equal(highlightCode("<danger>", "unknown-language", ui, ansi), "<danger>");
});

test("diff keeps addition and deletion signs with distinct colors", () => {
  const source = "@@ -1 +1 @@\n-old\n+new\n context";
  const rendered = highlightCode(source, "diff", ui, ansi);
  assert.equal(rendered.replace(/\u001b\[[0-9;]+m/g, ""), source);
  assert.match(rendered, /\u001b\[91m-old/);
  assert.match(rendered, /\u001b\[92m\+new/);
});
