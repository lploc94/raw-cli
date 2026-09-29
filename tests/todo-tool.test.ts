import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createStarterConfig } from "../src/management/starter.js";
import { PanelHost } from "../src/panels/host.js";
import { validateDocument } from "../src/panels/validate.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function setup() {
  const registry = new ToolRegistry();
  for (const plugin of await loadBundledTools(["todo"])) registry.register(plugin);
  const host = new PanelHost();
  let n = 0;
  const run = async (args: unknown) => {
    const call = host.begin(`c${++n}`, registry.panelDeclarations("todo")!);
    const result = await registry.dispatch("todo", args, { cwd: ".", maxOutputBytes: 65536, autoApprove: true,
      panels: call.context, onPanelUpdates: (updates) => call.collect(updates) });
    const settled = call.settle(false);
    call.commit();
    const stored = host.snapshot().find((panel) => panel.panelId === "builtin/todo#todo");
    return { result, text: result.content.map((block) => block.type === "text" ? block.text : "").join(""), settled, stored };
  };
  return { run, registry, host };
}
const ids = (stored: { document: { blocks: unknown[] } } | undefined) => {
  const block = stored?.document.blocks[0] as { items: Array<{ id: string; children?: Array<{ id: string }> }> } | undefined;
  return block?.items.flatMap((item) => [item.id, ...(item.children ?? []).map((child) => child.id)]);
};
const item = (content: string, status = "pending", extra: object = {}) => ({ content, status, ...extra });

test("the declaration is exactly the reference panel and loads without a session store", async () => {
  const { registry } = await setup();
  const owner = registry.panelDeclarations("todo")!;
  assert.equal(owner.owner, "builtin/todo");
  const [panel] = owner.declarations;
  assert.deepEqual([panel!.id, panel!.icon, panel!.open, panel!.context, panel!.acp_plan], ["todo", "list-checks", "first_update", "summary", true]);
  assert.deepEqual(panel!.actions.map((action) => [action.id, action.scope, action.kind]),
    [["complete", "item", "tool"], ["reopen", "item", "tool"], ["skip", "item", "tool"], ["continue", "panel", "prompt"], ["clear_done", "panel", "tool"]]);
  assert.equal(panel!.actions[0]!.primary, true);
});

test("replace numbers items with the smallest unused t<n>, whatever ids the model supplied", async () => {
  const { run } = await setup();
  const first = await run({ todos: [item("a", "pending", { id: "t1" }), item("b", "pending", { id: "t3" }), item("c")] });
  assert.deepEqual(ids(first.stored), ["t1", "t3", "t2"], "non-sequential supplied ids leave t2 for the generated one");
  const second = await run({ todos: [item("a", "pending", { id: "custom" }), item("b"), item("c"), item("d", "pending", { id: "t2" })] });
  assert.deepEqual(ids(second.stored), ["custom", "t1", "t3", "t2"]);
  const third = await run({ todos: [item("only")] });
  assert.deepEqual(ids(third.stored), ["t1"], "ids freed by replacement are issued again");
});

test("merge updates, adds, removes with subtasks, and reuses freed ids only in replace mode", async () => {
  const { run } = await setup();
  await run({ todos: [item("parent", "pending", { id: "p" }), item("child", "pending", { id: "c", parent: "p" }), item("other", "in_progress", { id: "o" })] });
  const merged = await run({ mode: "merge", todos: [{ id: "o", status: "done" }, { id: "n", content: "new one" }, { id: "c", note: "careful" }] });
  assert.deepEqual(ids(merged.stored), ["p", "c", "o", "n"]);
  assert.match(merged.text, /\[x\] o other/);
  assert.match(merged.text, /\[ \] c child — careful/);
  const removed = await run({ mode: "merge", todos: [{ id: "p", remove: true }] });
  assert.deepEqual(ids(removed.stored), ["o", "n"], "removing a parent removes its subtasks");
});

test("model-visible text matches the reference layout, and the panel carries progress, status and summary", async () => {
  const { run } = await setup();
  const { text, stored, settled } = await run({ title: "Ship it", todos: [
    item("Write the failing test", "done", { id: "t1" }), item("Fix the API", "in_progress", { id: "t2" }),
    item("Update docs", "pending", { id: "t3" }), item("Validate input", "pending", { id: "t5", parent: "t2" })] });
  assert.equal(text, ["Todo (1/3 done):", "[x] t1 Write the failing test", "[~] t2 Fix the API", "  [ ] t5 Validate input", "[ ] t3 Update docs"].join("\n"));
  const document = validateDocument(stored!.document);
  assert.equal(document.title, "Ship it");
  assert.equal(document.status, "active");
  assert.match(document.context_summary!, /^1\/3 done\n\[x\] t1 Write the failing test/);
  assert.equal(settled.receipts[0]?.summary, "1/3 · Fix the API");
  const finished = await run({ mode: "merge", todos: [{ id: "t2", status: "skipped" }, { id: "t5", status: "done" }, { id: "t3", status: "done" }] });
  assert.equal(finished.stored?.document.status, "done");
  assert.equal(finished.stored?.document.title, "Ship it", "the title is kept when the input has none");
  const empty = await run({ todos: [] });
  assert.equal(empty.text, "Todo (empty):");
  assert.equal(empty.stored?.document.status, "idle");
});

test("argument validation rejects each §18 rule before any state exists", async () => {
  const { run, registry } = await setup();
  const invalid = async (args: unknown, pattern: RegExp) => {
    const outcome = await run(args);
    assert.equal(outcome.result.isError, true, JSON.stringify(args));
    assert.equal(outcome.result.code, "invalid_arguments");
    assert.match(outcome.text + JSON.stringify(outcome.result.content), pattern);
    assert.equal(outcome.stored, undefined, "nothing was published");
  };
  await invalid({ todos: [{ content: "x" }] }, /content and status are required/);
  await invalid({ todos: [{ status: "pending" }] }, /content and status are required/);
  await invalid({ todos: [{ ...item("x"), remove: true }] }, /remove is only allowed in merge mode/);
  await invalid({ todos: [], clear: "done" }, /clear is only allowed in merge mode/);
  await invalid({ mode: "merge", todos: [{ content: "x" }] }, /id is required in merge mode/);
  await invalid({ todos: [item("a", "pending", { id: "x" }), item("b", "pending", { id: "x" })] }, /duplicate id "x"/);
  await invalid({ todos: [item("a", "in_progress"), item("b", "in_progress")] }, /at most one item may be in_progress/);
  await invalid({ todos: [item("a", "pending", { id: "a" }), item("b", "pending", { id: "b", parent: "a" }), item("c", "pending", { id: "c", parent: "b" })] }, /nesting is limited/);
  await invalid({ todos: [item("a", "pending", { id: "Bad Id" })] }, /pattern|id/);
  await invalid({ todos: Array.from({ length: 101 }, (_, n) => item(`i${n}`)) }, /100|items/);
  await invalid({ todos: [{ ...item("a"), extra: 1 }] }, /additional|extra/);
  assert.equal(registry.panelDeclarations("todo")?.declarations.length, 1);
});

test("state validation happens in the handler, names the item and leaves the panel at its previous revision", async () => {
  const { run, host } = await setup();
  await run({ todos: [item("parent", "in_progress", { id: "p" }), item("child", "pending", { id: "c", parent: "p" }), item("later", "pending", { id: "l" })] });
  const revision = () => host.snapshot()[0]!.revision;
  const before = revision();
  const bad = async (args: unknown, pattern: RegExp) => {
    const outcome = await run(args);
    assert.equal(outcome.result.isError, true);
    assert.equal(outcome.result.code, "invalid_todo");
    assert.match(outcome.text, pattern);
    assert.equal(revision(), before, "no update was published");
    assert.equal(outcome.settled.receipts.length, 0);
  };
  await bad({ mode: "merge", todos: [{ id: "p", status: "done" }] }, /item "p" cannot be done while its subtask "c" is pending/);
  await bad({ mode: "merge", todos: [{ id: "nope", status: "done" }] }, /item "nope": unknown id; adding an item needs content/);
  await bad({ mode: "merge", todos: [{ id: "nope", remove: true }] }, /item "nope": cannot remove/);
  await bad({ mode: "merge", todos: [{ id: "l", status: "in_progress" }] }, /at most one item may be in_progress/);
  await bad({ mode: "merge", todos: [{ id: "l", parent: "c" }] }, /parent "c" is itself a subtask/);
  await bad({ mode: "merge", todos: [{ id: "l", parent: "ghost" }] }, /parent "ghost" does not exist/);
  await bad({ todos: [item("x", "pending", { parent: "ghost" })] }, /parent "ghost" does not exist/);
  await bad({ mode: "merge", todos: [{ id: "p", status: "skipped" }] }, /item "p" cannot be skipped/);
  const ok = await run({ mode: "merge", todos: [{ id: "c", status: "done" }, { id: "p", status: "done" }] });
  assert.equal(ok.result.isError, false, "finishing the subtask in the same call allows completing the parent");
  assert.equal(revision(), before + 1);
});

test("a merge that would exceed 100 items is rejected", async () => {
  const { run, host } = await setup();
  await run({ todos: Array.from({ length: 100 }, (_, n) => item(`i${n}`)) });
  assert.equal(host.snapshot()[0]!.document.blocks.length, 1);
  const over = await run({ mode: "merge", todos: [{ id: "extra", content: "one too many" }] });
  assert.equal(over.result.code, "invalid_todo");
  assert.match(over.text, /item "extra": the list would hold 101 items; the limit is 100/);
});

test("clear removes finished items and their subtasks but keeps unfinished work", async () => {
  const { run } = await setup();
  await run({ todos: [item("done parent", "done", { id: "a" }), item("done child", "done", { id: "b", parent: "a" }),
    item("open parent", "pending", { id: "c" }), item("finished child", "skipped", { id: "d", parent: "c" }), item("open", "in_progress", { id: "e" })] });
  const cleared = await run({ mode: "merge", todos: [], clear: "done" });
  assert.deepEqual(ids(cleared.stored), ["c", "e"], "the finished subtask of an open parent goes too, the open parent stays");
  const again = await run({ mode: "merge", todos: [{ id: "e", status: "done" }], clear: "done" });
  assert.deepEqual(ids(again.stored), ["c"], "items changed in the same call are cleared after applying them");
});

test("builtin/todo is opt-in: the starter config never selects it and the example is generated with the build", async () => {
  const starter = JSON.stringify(createStarterConfig());
  assert.doesNotMatch(starter, /todo/);
  assert.ok(existsSync("examples/tools/todo/tool.json") && existsSync("examples/tools/todo/index.mjs"));
  assert.equal(readFileSync("examples/tools/todo/tool.json", "utf8"), readFileSync("src/tools/bundled/todo/tool.json", "utf8"));
});

test("capacity is checked on the resulting list: merge with clear may replace a full finished list, and remove ignores other fields", async () => {
  const { run } = await setup();
  await run({ todos: Array.from({ length: 100 }, (_, n) => item(`i${n}`, "done")) });
  const next = await run({ mode: "merge", todos: [{ id: "next", content: "Next task" }], clear: "done" });
  assert.equal(next.result.isError, false);
  assert.deepEqual(ids(next.stored), ["next"]);
  const gone = await run({ mode: "merge", todos: [{ id: "next", content: "ignored", remove: true }] });
  assert.equal(gone.result.isError, false);
  assert.deepEqual(ids(gone.stored), []);
  const unknown = await run({ mode: "merge", todos: [{ id: "ghost", content: "x", remove: true }] });
  assert.equal(unknown.result.code, "invalid_todo");
  assert.match(unknown.text, /item "ghost": cannot remove/);
});
