import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../src/tools/primitives.js";
import { buildWriteChanges } from "../src/tools/write-changes.js";
import { validateDocument } from "../src/panels/validate.js";
import type { PanelDocument, PanelContext, FileEntry } from "../src/panels/contract.js";

const entries = (doc: PanelDocument) => (doc.blocks.find(b => b.kind === "files") as {entries: FileEntry[]}).entries;

test("successful writes accumulate normalized paths, preserve added status and omit failed operations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-changes-"));
  let document: PanelDocument | undefined;
  const panels: PanelContext = { protocol: 2, get: () => document ? { revision: 1, document } : undefined,
    update: async (_id, update) => { assert.equal(update.op, "replace"); if (update.op === "replace") document = update.document; return { revision: 1 }; } };
  try {
    await mkdir(join(cwd, "directory"));
    const result = await writeFileTool({ operations: [{ path: "a", mode: "overwrite", content: "one\n" },
      { path: "directory", mode: "overwrite", content: "fails" }, { path: "b", mode: "append", content: "two" }] }, { cwd, panels, maxOutputBytes: 4096 });
    assert.equal(result.isError, true);
    assert.deepEqual(entries(document!).map(e => e.path), [join(cwd, "a"), join(cwd, "b")]);
    await writeFileTool({ operations: [{ path: "./a", mode: "overwrite", content: "updated\n" }] }, { cwd, panels, maxOutputBytes: 4096 });
    assert.equal(entries(document!).length, 2);
    assert.equal(entries(document!).find(e => e.path === join(cwd, "a"))?.status, "added");
    assert.match(JSON.stringify(document), /updated/);
    validateDocument(document);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Files changed is bounded after reload and rename records both paths", () => {
  let document: PanelDocument | undefined;
  for (let i = 0; i < 210; i++) document = buildWriteChanges(document, [{ path: `/p/${i}`, kind: "added", after: Buffer.from("x".repeat(40000)) }]);
  document = buildWriteChanges(structuredClone(document), [{ path: "/p/new", oldPath: "/p/209", kind: "renamed", before: Buffer.from("x"), after: Buffer.from("y") }]);
  assert.ok(entries(document).length <= 200);
  assert.match(document.summary!, /omitted/);
  assert.match(JSON.stringify(document), /209.*new/);
  assert.match(JSON.stringify(document), /truncated|Recent diff/);
  assert.ok(Buffer.byteLength(JSON.stringify(document)) <= 65536);
  validateDocument(document);
});

test("panel failure does not report completed filesystem writes as failed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-changes-"));
  try {
    const result = await writeFileTool({ operations: [{ path: "a", mode: "overwrite", content: "done" }] }, { cwd, maxOutputBytes: 4096,
      panels: { protocol: 2, get: () => undefined, update: async () => { throw new Error("panel limit"); } } });
    assert.equal(result.isError, false);
    assert.equal(await readFile(join(cwd, "a"), "utf8"), "done");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a cancelled real write call persists only completed writes and survives session reload", async () => {
  const { createAgent } = await import("../src/agent.js");
  const { openSessionStore } = await import("../src/sessions/store.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { loadBundledTools } = await import("../src/tools/plugins/loader.js");
  const cwd = await mkdtemp(join(tmpdir(), "raw-write-abort-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd } });
  const sessionId = store.createSession({ cwd, title: "write abort" }).id;
  const registry = new ToolRegistry();
  for (const tool of await loadBundledTools(["write_file"])) registry.register(tool);
  const agent = createAgent({ cwd, registry, autoApprove: true, maxOutputBytes: 8192, maxSteps: 2, persistence: { store, sessionId, surface: "cli" },
    provider: { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "write-abort", name: "write_file", arguments: {
        operations: [{ path: "completed", mode: "overwrite", content: "yes" }, { path: "skipped", mode: "overwrite", content: "no" }],
      } }] }) } });
  try {
    const result = await agent.run("write", event => { if (event.type === "panel_update" && event.live && event.owner === "builtin/write_file") agent.abort(); });
    assert.equal(result.status, "cancelled");
    assert.equal(await readFile(join(cwd, "completed"), "utf8"), "yes");
    await assert.rejects(readFile(join(cwd, "skipped")), { code: "ENOENT" });
    const saved = store.listSessionPanels(sessionId);
    assert.equal(saved.length, 1);
    assert.deepEqual(entries(saved[0]!.document).map(e => e.path), [join(cwd, "completed")]);
    const { PanelHost } = await import("../src/panels/host.js");
    const restored = new PanelHost({ initial: saved });
    assert.deepEqual(restored.snapshot(), saved);
    restored.close();
  } finally { await agent.close(); store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("write-only existing files still overwrite successfully and unavailable snapshots are explicit", async () => {
  const { chmod, writeFile } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "raw-write-only-"));
  const path = join(cwd, "private");
  let document: PanelDocument | undefined;
  try {
    await writeFile(path, "old");
    await chmod(path, 0o200);
    const result = await writeFileTool({ operations: [{ path, mode: "overwrite", content: "new" }] }, { cwd, maxOutputBytes: 4096,
      panels: { protocol: 2, get: () => undefined, update: async (_id, update) => { if (update.op === "replace") document = update.document; return { revision: 1 }; } } });
    assert.equal(result.isError, false);
    assert.equal(entries(document!)[0]?.status, "modified");
    if (process.getuid?.() !== 0 && process.platform !== "win32") assert.match(JSON.stringify(document), /diff unavailable/);
    await chmod(path, 0o600);
    assert.equal(await readFile(path, "utf8"), "new");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("invalid or oversized display paths are omitted honestly without failing document validation", () => {
  const doc = buildWriteChanges(undefined, [{ path: "/" + "a".repeat(600), kind: "added", after: Buffer.from("x") },
    { path: "/newline\nfile", kind: "added", after: Buffer.from("y") }]);
  assert.equal(entries(doc).length, 0);
  assert.equal(doc.summary, "0 paths shown; 2 history entries omitted");
  validateDocument(doc);
});
