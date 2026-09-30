import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseToolManifest } from "../src/tools/plugins/manifest.js";
import { validateDocument } from "../src/panels/validate.js";
import { renderPanelText } from "../src/panels/render.js";
import { isClosedMermaidFence, mermaidSourceError } from "../web/src/diagrams/policy.js";

test("Mermaid documents preserve title/source/fallback in shared CLI and ACP text rendering", () => {
  const document = validateDocument({ blocks: [{ id: "flow", kind: "mermaid", title: "Delivery",
    source: "flowchart LR\nA-->B", fallback: "A leads to B" }] });
  const text = renderPanelText("Overview", document);
  assert.match(text, /## Delivery/);
  assert.match(text, /A leads to B/);
  assert.match(text, /flowchart LR\nA-->B/);
  assert.doesNotMatch(text, /Unsupported block/);
});

test("Mermaid contract enforces UTF-8 byte limits independently of browser fallback policy", () => {
  const doc = (source: string) => ({ blocks: [{ id: "d", kind: "mermaid", source }] });
  assert.doesNotThrow(() => validateDocument(doc("a".repeat(16 * 1024))));
  assert.throws(() => validateDocument(doc("é".repeat(8193))), /16384 bytes/);
  assert.throws(() => validateDocument(doc("")), /must not be empty/);
  assert.doesNotThrow(() => validateDocument(doc("%%{init: {securityLevel: 'loose'}}%%\nflowchart LR\nA-->B")),
    "display rejection must not fail a valid tool result");
});

test("ordinary flowchart and sequence sources pass the renderer preflight", () => {
  for (const source of ["flowchart LR\nA[Start] --> B{Ready?}\nB -->|yes| C[Done]",
    "sequenceDiagram\nparticipant User\nparticipant Server\nUser->>Server: Request\nServer-->>User: Result",
    "%% comment\ngraph TD\nA-->B", "flowchart LR\nA<-->B"]) {
    assert.equal(mermaidSourceError(source), undefined, source);
  }
});

test("hostile and overly complex sources fail before Mermaid has any DOM access", () => {
  for (const source of ["%%{init: {securityLevel: 'loose'}}%%\ngraph LR\nA-->B",
    "---\nconfig:\n securityLevel: loose\n---\ngraph LR\nA-->B",
    'flowchart LR\nA["<img src=x onerror=alert(1)>"]',
    'flowchart LR\nA-->B\nclick A "https://example.com"',
    'flowchart LR;A-->B;style A fill:url(/tracking)',
    'flowchart LR\nA-->B style A fill:u\\72l(/tracking)',
    'flowchart LR\nA@{ img: "/tracking", label: "photo" }',
    'sequenceDiagram\nparticipant A\nlink A: Visit @ /tracking',
    'flowchart LR\nA["$$x$$"]', "flowchart LR\nA[https://example.com]",
    "flowchart LR\n" + "A-->B;".repeat(101), "flowchart LR\n" + "A;".repeat(301),
    "a".repeat(16385), "é".repeat(8193), "", "graph LR\nA\u0000B"]) {
    assert.ok(mermaidSourceError(source), source.slice(0, 80));
  }
});

test("only completed matching Markdown fences become diagrams during streaming", () => {
  const closed = "Before\n```mermaid\nflowchart LR\nA-->B\n```\nAfter";
  assert.equal(isClosedMermaidFence(closed, 7, closed.indexOf("\nAfter")), true);
  assert.equal(isClosedMermaidFence("```mermaid\nflowchart LR\nA-->B", 0, 30), false);
  assert.equal(isClosedMermaidFence("````mermaid\ngraph LR\nA-->B\n```", 0, 33), false);
  assert.equal(isClosedMermaidFence("~~~mermaid\ngraph LR\nA-->B\n~~~", 0, 100), true);
  assert.equal(isClosedMermaidFence("```mermaid\ngraph LR\nA-->B\n~~~", 0, 100), false);
  assert.equal(isClosedMermaidFence("```mermaid", 0, 100), false);
  assert.equal(isClosedMermaidFence("```mermaid\ngraph LR\nA-->B\n```", undefined, undefined), false);
});

test("the standalone diagram example declares sidebar v2 and publishes through the supported panel API", async () => {
  const manifest = parseToolManifest(JSON.parse(await readFile(new URL("../examples/tools/diagram/tool.json", import.meta.url), "utf8")), "local/diagram", "diagram");
  assert.equal(manifest.panels?.[0]?.placement, "sidebar");
  const example = await import(new URL("../examples/tools/diagram/index.mjs", import.meta.url).href);
  const updates: unknown[] = [];
  const context = { panels: { update: async (panel: string, update: { document: unknown }) => {
    assert.equal(panel, "diagram"); validateDocument(update.document); updates.push(update);
  } } };
  const source = "sequenceDiagram\nA->>B: Hello";
  const result = await example.handler({ source, title: "Sequence", fallback: "Hello" }, context);
  assert.equal(result.content[0].text, "Hello");
  assert.equal(updates.length, 1);
  assert.equal((await example.handler({ source: "é".repeat(8193) }, context)).isError, true);
  assert.equal(updates.length, 1, "oversized source does not publish");
});
