import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { packPackage } from "../src/packages/archive.js";
import { addPackageAgent } from "../src/packages/cli.js";
import { inspectPackage } from "../src/packages/inspect.js";
import { installPackage } from "../src/packages/store.js";
import { PanelHost } from "../src/panels/host.js";
import type { StoredPanel } from "../src/panels/contract.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import type { ToolResult } from "../src/tools/types.js";
import { slashProvider } from "../web/src/composer/commands.js";

const KIT = join("examples", "packages", "coding-kit");
/**
 * The identity a package tool's panel keeps: the asset's canonical identity, which names the package (not the
 * recipient's alias) and the export. `pkg/coding-kit/tools/goal` resolves to it; policy checks the canonical one.
 */
const OWNER = "@raw/coding-kit#tools/goal";
const PANEL_ID = `${OWNER}#goal`;

const model = () => ({ provider: "ollama", method: "openai-chat-completions", model_id: "fixture",
  base_url: "http://127.0.0.1:9/v1" });
const textOf = (result: ToolResult) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

/** The items of the first block: where the goal keeps its acceptance criteria, and what `acp_plan` publishes. */
function criteriaItems(panel: StoredPanel | undefined): Array<Record<string, unknown>> {
  const block = panel?.document.blocks[0];
  return block !== undefined && "items" in block ? [...(block.items as Array<Record<string, unknown>>)] : [];
}

/** The items of one named block, when the panel has it. */
function blockItems(panel: StoredPanel | undefined, blockId: string): Array<Record<string, unknown>> {
  const block = panel?.document.blocks.find((entry) => entry.id === blockId);
  return block !== undefined && "items" in block ? [...(block.items as Array<Record<string, unknown>>)] : [];
}

/** The events of one timeline block, when the panel has that block. */
function timelineEvents(panel: StoredPanel | undefined, blockId: string): Array<Record<string, unknown>> {
  const block = panel?.document.blocks.find((entry) => entry.id === blockId);
  return block !== undefined && "events" in block ? [...(block.events as Array<Record<string, unknown>>)] : [];
}

type RuntimeTools = Awaited<ReturnType<typeof createRuntimeTools>>;
interface RunResult { result: ToolResult; text: string; stored: StoredPanel | undefined }
interface InstalledKit {
  tools: RuntimeTools;
  host: PanelHost;
  configPath: string;
  original: { default_agent: string; agents: Record<string, Record<string, unknown>> };
  run: (args: unknown) => Promise<RunResult>;
  dispatch: RuntimeTools["registry"]["dispatch"];
}

/**
 * Copies the authored kit to a throwaway author directory, packs it, removes that source, then installs and binds it
 * into a recipient config, so every test sees what a recipient gets (docs/packages.md §"Source, artifact and recipient").
 */
async function withInstalledKit(body: (kit: InstalledKit) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "raw-coding-kit-"));
  const dataHome = join(root, "data");
  const configPath = join(root, "raw.json");
  const archive = join(root, "coding-kit.rawpkg");
  const author = join(root, "author");
  const original = { default_agent: "existing", models: { local: model() },
    agents: { existing: { model: "local", tools: { use: [] } } } };
  writeFileSync(configPath, JSON.stringify(original));
  // Install, binding and runtime resolution must agree on one data root; `addPackageAgent` reads it from the
  // environment, so the whole case runs with the recipient's own data home (docs/packages.md §"Local installation").
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    cpSync(KIT, author, { recursive: true });
    await packPackage(author, archive);
    rmSync(author, { recursive: true, force: true });
    await installPackage({ configPath, source: archive, alias: "coding-kit", dataHome });
    await addPackageAgent({ configPath, name: "coder", from: "pkg/coding-kit/agents/coder", model: "local" });
    const runtime = await loadConfig({ configPath, flags: { agent: "coder" }, requireModel: false });
    const tools = await createRuntimeTools({ runtime, cwd: root });
    const host = new PanelHost();
    let calls = 0;
    const run = async (args: unknown): Promise<RunResult> => {
      const call = host.begin(`c${++calls}`, tools.registry.panelDeclarations("goal")!);
      const result = await tools.registry.dispatch("goal", args, { cwd: root, maxOutputBytes: 65536, autoApprove: true,
        panels: call.context, onPanelUpdates: (updates) => call.collect(updates) });
      call.settle(false);
      call.commit();
      return { result, text: textOf(result), stored: host.snapshot().find((panel) => panel.panelId === PANEL_ID) };
    };
    try {
      await body({ tools, host, configPath, original, run,
        dispatch: (name, args, context) => tools.registry.dispatch(name, args, context) });
    } finally { await tools.mcp.close(); }
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("the shipped coding kit exposes one agent, one panel tool and two skills", async () => {
  const report = await inspectPackage(KIT);
  assert.equal(report.name, "@raw/coding-kit");
  assert.deepEqual(report.exports.agents, ["coder"]);
  assert.deepEqual(report.exports.tools, ["goal"]);
  assert.deepEqual([...report.exports.skills].sort(), ["coding-workflow", "goal"]);
  assert.ok(report.requires.includes("raw.panel/2"), "a tool that declares panels needs the panel capability");
  assert.deepEqual(report.prerequisites, []);
});

test("packing the kit twice produces the same archive bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-coding-kit-pack-"));
  try {
    const first = await packPackage(KIT, join(root, "first.rawpkg"));
    const second = await packPackage(KIT, join(root, "second.rawpkg"));
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.bytes, second.bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a recipient binds the kit agent without changing its existing config", async () => {
  await withInstalledKit(async (kit) => {
    const bound = JSON.parse(readFileSync(kit.configPath, "utf8")) as { default_agent: string;
      agents: Record<string, Record<string, unknown>> };
    assert.equal(bound.default_agent, kit.original.default_agent);
    assert.deepEqual(bound.agents.existing, kit.original.agents.existing);
    assert.deepEqual(bound.agents.coder, { from: "pkg/coding-kit/agents/coder", model: "local" });
    assert.ok(kit.tools.selectedNames.includes("goal"), "the packaged goal tool is selected for the bound agent");
  });
});

test("the goal panel is declared with the reference shape and four actions", async () => {
  await withInstalledKit(async (kit) => {
    const owner = kit.tools.registry.panelDeclarations("goal")!;
    assert.equal(owner.owner, OWNER);
    const [panel] = owner.declarations;
    assert.deepEqual([panel!.id, panel!.icon, panel!.open, panel!.context, panel!.acp_plan],
      ["goal", "flag", "first_update", "summary", true]);
    assert.deepEqual(panel!.actions.map((action) => [action.id, action.scope, action.kind]),
      [["continue", "panel", "prompt"], ["achieve", "panel", "tool"], ["abandon", "panel", "tool"], ["explain", "item", "prompt"]]);
    assert.deepEqual(panel!.actions[1]!.arguments, { mode: "update", outcome: "achieved" });
    assert.ok(panel!.actions[2]!.confirm, "abandoning a goal asks for confirmation");
    assert.deepEqual(panel!.actions[3]!.when, { status: ["blocked"] });
  });
});

test("set publishes the goal with the criteria checklist first and a bounded context summary", async () => {
  await withInstalledKit(async (kit) => {
    const { result, text, stored } = await kit.run({ mode: "set", goal: "Ship the coding kit",
      done_when: "package validates and installs",
      criteria: [{ label: "validate passes" }, { label: "pack is deterministic" }], steps: [{ label: "author the kit" }] });
    assert.equal(result.isError, false);
    assert.equal(stored?.document.blocks[0]?.kind, "checklist", "acp_plan reads the first checklist block");
    assert.equal(stored?.document.blocks[0]?.id, "criteria");
    assert.deepEqual(criteriaItems(stored).map((item) => [item.id, item.label]),
      [["c1", "validate passes"], ["c2", "pack is deterministic"]]);
    assert.equal(stored?.document.status, "active");
    assert.match(stored?.document.context_summary ?? "", /Ship the coding kit/);
    assert.ok(Buffer.byteLength(stored?.document.context_summary ?? "") <= 2048);
    assert.match(text, /c1/);
  });
});

test("update merges by id and an unknown id changes nothing", async () => {
  await withInstalledKit(async (kit) => {
    await kit.run({ mode: "set", goal: "Keep the docs true", done_when: "no stale claim remains",
      criteria: [{ label: "read the doc" }, { label: "fix the claim" }] });
    const updated = await kit.run({ mode: "update", criteria: [{ id: "c2", status: "done" }] });
    assert.equal(updated.result.isError, false);
    assert.deepEqual(criteriaItems(updated.stored).map((item) => [item.id, item.status ?? "pending"]),
      [["c1", "pending"], ["c2", "done"]]);
    const rejected = await kit.run({ mode: "update", criteria: [{ id: "missing", status: "done" }] });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.code, "invalid_goal");
    assert.match(rejected.text, /missing/);
    assert.deepEqual(rejected.stored?.document, updated.stored?.document, "a rejected update keeps the committed document");
  });
});

test("an achieved outcome closes the panel and records the event", async () => {
  await withInstalledKit(async (kit) => {
    await kit.run({ mode: "set", goal: "Close it out", done_when: "done", criteria: [{ label: "one thing" }] });
    const closed = await kit.run({ mode: "update", outcome: "achieved" });
    assert.equal(closed.result.isError, false);
    assert.equal(closed.stored?.document.status, "done");
    assert.equal(closed.stored?.document.blocks.find((block) => block.id === "log")?.kind, "timeline");
    assert.equal(timelineEvents(closed.stored, "log").length, 1);
  });
});

test("the criteria limit is refused and a host without panels is refused", async () => {
  await withInstalledKit(async (kit) => {
    const tooMany = await kit.run({ mode: "set", goal: "Too much", done_when: "never",
      criteria: Array.from({ length: 51 }, (_, index) => ({ label: `criterion ${index}` })) });
    assert.equal(tooMany.result.isError, true);
    assert.equal(tooMany.result.code, "invalid_goal");
    assert.equal(kit.host.snapshot().length, 0, "a refused set never publishes a panel");
    const noPanels = await kit.dispatch("goal", { mode: "set", goal: "g", done_when: "d" },
      { cwd: ".", maxOutputBytes: 65536, autoApprove: true });
    assert.equal(noPanels.isError, true);
    assert.equal(noPanels.code, "panels_unavailable");
  });
});

test("update adds a criterion that carries no id yet", async () => {
  await withInstalledKit(async (kit) => {
    await kit.run({ mode: "set", goal: "Grow the list", done_when: "two criteria are met",
      criteria: [{ label: "first" }] });
    const added = await kit.run({ mode: "update",
      criteria: [{ label: "discovered later", status: "done", note: "found in review" }] });
    assert.equal(added.result.isError, false);
    const items = criteriaItems(added.stored);
    assert.deepEqual(items.map((item) => [item.id, item.label, item.status ?? "pending"]),
      [["c1", "first", "pending"], ["c2", "discovered later", "done"]]);
    assert.equal(items[1]?.note, "found in review");
  });
});

test("more than one step in progress is refused", async () => {
  await withInstalledKit(async (kit) => {
    await kit.run({ mode: "set", goal: "Keep one step moving", done_when: "one step at a time",
      steps: [{ label: "one" }, { label: "two" }] });
    const refused = await kit.run({ mode: "update",
      steps: [{ id: "s1", status: "in_progress" }, { id: "s2", status: "in_progress" }] });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.code, "invalid_goal");
    assert.match(refused.text, /at most one step may be in_progress/);
  });
});

test("a goal that cannot fit the panel header is refused with its limit", async () => {
  await withInstalledKit(async (kit) => {
    const refused = await kit.run({ mode: "set", goal: "x".repeat(81), done_when: "done" });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.code, "invalid_arguments");
    assert.match(refused.text, /at most 80 characters/);
    assert.equal(kit.host.snapshot().length, 0, "a refused goal never publishes a panel");
  });
});

test("set refuses more than one step in progress, like update does", async () => {
  await withInstalledKit(async (kit) => {
    const refused = await kit.run({ mode: "set", goal: "Keep one step moving", done_when: "one at a time",
      steps: [{ label: "one", status: "in_progress" }, { label: "two", status: "in_progress" }] });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.code, "invalid_goal");
    assert.match(refused.text, /at most one step may be in_progress/);
    assert.equal(kit.host.snapshot().length, 0, "a refused set never publishes a panel");
  });
});

test("a step detail longer than the panel allows is refused as arguments", async () => {
  await withInstalledKit(async (kit) => {
    const refused = await kit.run({ mode: "set", goal: "Bound the detail", done_when: "the panel accepts it",
      steps: [{ label: "step", detail: "x".repeat(201) }] });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.code, "invalid_arguments");
    assert.equal(kit.host.snapshot().length, 0);
    const accepted = await kit.run({ mode: "set", goal: "Bound the detail", done_when: "the panel accepts it",
      steps: [{ label: "step", detail: "x".repeat(200) }] });
    assert.equal(accepted.result.isError, false, "200 characters is the panel's own limit and must pass");
  });
});

test("set applies the outcome it was given", async () => {
  await withInstalledKit(async (kit) => {
    const abandoned = await kit.run({ mode: "set", goal: "Stop this", done_when: "the user stops",
      criteria: [{ label: "one thing" }], outcome: "abandoned" });
    assert.equal(abandoned.result.isError, false);
    assert.equal(abandoned.stored?.document.status, "failed");
    assert.equal(timelineEvents(abandoned.stored, "log").length, 1);
    const achieved = await kit.run({ mode: "set", goal: "Finish this", done_when: "it is done", outcome: "achieved" });
    assert.equal(achieved.stored?.document.status, "done");
  });
});

test("a document that cannot fit the panel is refused instead of reported as success", async () => {
  await withInstalledKit(async (kit) => {
    const criteria = Array.from({ length: 50 }, (_, index) => ({ label: `好${index}`.padEnd(200, "好"), note: "好".repeat(300) }));
    const steps = Array.from({ length: 30 }, (_, index) => ({ label: `步${index}`.padEnd(200, "好"), detail: "好".repeat(200) }));
    const refused = await kit.run({ mode: "set", goal: "Too big to store", done_when: "it fits", criteria, steps });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.code, "invalid_goal");
    assert.match(refused.text, /65536|64 KiB/);
    assert.equal(kit.host.snapshot().length, 0, "nothing was committed");
  });
});

test("the compaction summary says whether the goal is still open", async () => {
  await withInstalledKit(async (kit) => {
    const active = await kit.run({ mode: "set", goal: "Still working", done_when: "criteria met",
      criteria: [{ label: "open one" }] });
    assert.match(active.stored?.document.context_summary ?? "", /active/i);
    const abandoned = await kit.run({ mode: "update", outcome: "abandoned" });
    assert.match(abandoned.stored?.document.context_summary ?? "", /abandoned/i);
    const closed = await kit.run({ mode: "set", goal: "Done deal", done_when: "it is met", outcome: "achieved" });
    assert.match(closed.stored?.document.context_summary ?? "", /achieved/i);
  });
});

test("text that is only control characters cannot become the goal or a label", async () => {
  await withInstalledKit(async (kit) => {
    // Argument-level refusals come back as `invalid_arguments`, like every other validateArgs failure.
    const emptyGoal = await kit.run({ mode: "set", goal: "\u0001", done_when: "something" });
    assert.equal(emptyGoal.result.isError, true);
    assert.equal(emptyGoal.result.code, "invalid_arguments");
    assert.match(emptyGoal.text, /goal/);
    assert.equal(kit.host.snapshot().length, 0);
    const emptyLabel = await kit.run({ mode: "set", goal: "Real goal", done_when: "something",
      criteria: [{ label: "\u0002" }] });
    assert.equal(emptyLabel.result.isError, true);
    assert.equal(emptyLabel.result.code, "invalid_arguments");
    assert.match(emptyLabel.text, /criteria\[0\]/);
  });
});

test("the same outcome is recorded once, and a full log refuses another transition by name", async () => {
  await withInstalledKit(async (kit) => {
    const stored = () => kit.host.snapshot().find((panel) => panel.panelId === PANEL_ID);
    await kit.run({ mode: "set", goal: "Count the log", done_when: "the log stays bounded",
      criteria: [{ label: "one" }] });
    const closed = await kit.run({ mode: "update", outcome: "achieved" });
    assert.equal(closed.result.isError, false);
    const repeated = await kit.run({ mode: "update", outcome: "achieved" });
    assert.equal(repeated.result.isError, false, "closing an already closed goal is not an error");
    assert.equal(timelineEvents(stored(), "log").length, 1, "the same outcome is recorded once");
    // The host keeps at most 100 timeline events (src/panels/validate.ts), so fill the log with real transitions.
    for (let index = 0; index < 99; index++) {
      const flip = await kit.run({ mode: "update", outcome: index % 2 === 0 ? "abandoned" : "achieved" });
      assert.equal(flip.result.isError, false, `transition ${index + 2} must be recordable`);
    }
    assert.equal(timelineEvents(stored(), "log").length, 100);
    const next = stored()?.document.status === "done" ? "abandoned" : "achieved";
    const overflow = await kit.run({ mode: "update", outcome: next });
    assert.equal(overflow.result.isError, true);
    assert.equal(overflow.result.code, "invalid_goal");
    assert.match(overflow.text, /100/);
    assert.equal(timelineEvents(stored(), "log").length, 100, "a refused outcome stores nothing");
  });
});

test("generated ids never collide with an id the other collection already uses", async () => {
  await withInstalledKit(async (kit) => {
    const created = await kit.run({ mode: "set", goal: "Keep ids unique across both lists",
      done_when: "one update can name an id from each list",
      criteria: [{ id: "s1", label: "criterion" }], steps: [{ label: "step" }] });
    assert.equal(created.result.isError, false);
    const criteria = blockItems(created.stored, "criteria").map((item) => item.id);
    const steps = blockItems(created.stored, "steps").map((item) => item.id);
    assert.deepEqual(criteria, ["s1"], "an explicit id is kept as given");
    assert.notEqual(steps[0], "s1", "the generated step id must avoid the criterion's explicit s1");
    const both = await kit.run({ mode: "update",
      criteria: [{ id: criteria[0], status: "done" }], steps: [{ id: steps[0], status: "done" }] });
    assert.equal(both.result.isError, false, "one update names an id from each list");
    assert.deepEqual(blockItems(both.stored, "criteria").map((item) => item.status), ["done"]);
    assert.deepEqual(blockItems(both.stored, "steps").map((item) => item.status), ["done"]);
  });
});

test("the step-count and done_when limits are refused by name", async () => {
  await withInstalledKit(async (kit) => {
    const manySteps = await kit.run({ mode: "set", goal: "Too many steps", done_when: "it fits",
      steps: Array.from({ length: 31 }, (_, index) => ({ label: `step ${index}` })) });
    assert.equal(manySteps.result.isError, true);
    assert.equal(manySteps.result.code, "invalid_goal");
    assert.match(manySteps.text, /31 steps; the limit is 30/);
    const longDoneWhen = await kit.run({ mode: "set", goal: "Bound the subtitle", done_when: "x".repeat(121) });
    assert.equal(longDoneWhen.result.isError, true);
    assert.equal(longDoneWhen.result.code, "invalid_arguments");
    assert.match(longDoneWhen.text, /at most 120 characters/);
    assert.equal(kit.host.snapshot().length, 0, "neither refusal published a panel");
    const accepted = await kit.run({ mode: "set", goal: "Bound the subtitle", done_when: "x".repeat(120),
      steps: Array.from({ length: 30 }, (_, index) => ({ label: `step ${index}` })) });
    assert.equal(accepted.result.isError, false, "both boundaries themselves are accepted");
  });
});

test("the goal skill parses and the composer offers /goal", async () => {
  const folder = join(KIT, "skills", "goal");
  const skill = parseSkillMarkdown(readFileSync(join(folder, "SKILL.md"), "utf8"), "goal");
  assert.equal(skill.name, "goal");
  assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
  const actions = { compact: { run: () => {} }, rename: () => {}, newChat: () => {}, details: () => {} };
  const provider = slashProvider(actions, [{ name: skill.name, description: skill.description }]);
  const items = await provider.items("");
  assert.ok(items.some((item) => item.label === "/goal"), "a selected skill named goal appears as /goal");
});
