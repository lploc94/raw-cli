import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, MarkdownStream } from "../src/terminal/markdown.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";

const ui = resolveUiOptions({ color: "always", theme: "dark" });
const color = terminalCapabilities(true, { TERM: "xterm" }, ui);
const plain = terminalCapabilities(false, { TERM: "dumb" }, ui);
const strip = (value: string) => value.replace(/\u001b\[[0-9;]+m/g, "");

test("Markdown renders headings, inline code, links, lists, quotes, tables and source code", () => {
  const input = "# Title\n\nA **bold** word with `inline` and [docs](https://example.com).\n\n"
    + "- first\n- second\n\n> quoted\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n"
    + "```ts\nconst x: number = 42;\n```\n";
  const rendered = renderMarkdown(input, ui, color, 80);
  const text = strip(rendered);
  assert.match(text, /Title/);
  assert.match(text, /inline/);
  assert.match(text, /https:\/\/example.com/);
  assert.match(text, /first/);
  assert.match(text, /quoted/);
  assert.match(text, /Key/);
  assert.equal(text.match(/const x: number = 42;/g)?.length, 1);
  assert.match(rendered, /\u001b\[/);
  assert.equal(renderMarkdown(input, ui, plain, 40).includes("\u001b["), false);
});

test("incomplete fences and split chunks display promptly and flush exactly once", () => {
  const source = "Start\n\n```typescript\nconst answer = 42;\n```\n\nDone.";
  for (const parts of [source.match(/./gs)!, [source.slice(0, 13), source.slice(13, 21), source.slice(21)]]) {
    const stream = new MarkdownStream(ui, color, 80);
    let committed = "";
    let sawOpenCode = false;
    for (const part of parts) {
      const frame = stream.push(part);
      committed += frame.committed;
      if (strip(frame.tail + frame.committed).includes("const answer")) sawOpenCode = true;
    }
    const final = committed + stream.flush();
    assert.equal(strip(final), strip(renderMarkdown(source, ui, color, 80)));
    assert.equal(strip(final).match(/const answer = 42;/g)?.length, 1);
    assert.equal(stream.flush(), "");
    assert.equal(sawOpenCode, true);
  }
});

test("large incomplete blocks keep progressing with bounded parser source", () => {
  const stream = new MarkdownStream(ui, color, 40);
  const content = "```ts\n" + "const x = 1;\n".repeat(4000);
  let committed = "";
  for (const chunk of content.match(/.{1,100}/gs)!) {
    const frame = stream.push(chunk);
    committed += frame.committed;
    assert.ok(frame.tail.split("\n").length <= 21);
  }
  committed += stream.flush();
  assert.ok(committed.includes("const x = 1;"));
  assert.equal(strip(committed).match(/const x = 1;/g)?.length, 4000);
  assert.ok(stream.maxPendingBytes <= 32768);
});
