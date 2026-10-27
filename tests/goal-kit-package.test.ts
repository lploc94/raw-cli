import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { inspectPackage } from "../src/packages/inspect.js";
import { validateDocument } from "../src/panels/validate.js";

const ROOT = "examples/packages/goal-kit";

interface StateApi {
  STATE_VERSION: number;
  MAX_STATE_BYTES: number;
  MAX_CONTENT_BYTES: number;
  MAX_SEEN_SESSIONS: number;
  validateState(value: unknown): unknown;
  stateDir(env?: NodeJS.ProcessEnv): string;
  statePath(cwd: string, env?: NodeJS.ProcessEnv): string;
  stateLockPath(cwd: string, env?: NodeJS.ProcessEnv): string;
  readState(cwd: string, env?: NodeJS.ProcessEnv): Promise<unknown>;
  updateState(cwd: string, mutate: (state: Record<string, unknown>) => Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<unknown>;
  deleteState(cwd: string, env?: NodeJS.ProcessEnv): Promise<void>;
}

async function stateApi(): Promise<StateApi> {
  // @ts-expect-error - the shipped package helper is plain .mjs without a declaration file
  return await import("../examples/packages/goal-kit/tools/goal/state.mjs") as unknown as StateApi;
}

function stateFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    goalId: "00000000-0000-4000-8000-000000000001",
    status: "active",
    objective: "Ship the fix",
    doneWhen: "The tests pass",
    criteria: [{ id: "c1", label: "Tests pass", required: true, status: "pending" }],
    steps: [],
    budget: { maxContinuations: 20 },
    baselinePending: true,
    continuations: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tempStateEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-state-"));
  return { root, env: { ...process.env, RAW_GOAL_STATE_DIR: join(root, "state") } };
}

test("goal kit manifest exports the agent, tool, hook and skill", async () => {
  const report = await inspectPackage(ROOT);
  assert.equal(report.name, "@raw/goal-kit");
  assert.equal(report.version, "1.0.0");
  assert.deepEqual(report.exports.agents, ["coder"]);
  assert.deepEqual(report.exports.tools, ["goal"]);
  assert.deepEqual(report.exports.hooks, ["goal"]);
  assert.deepEqual(report.exports.skills, ["goal"]);
  assert.deepEqual(report.requires, [
    "raw.agent/1",
    "raw.hook/2",
    "raw.panel/2",
    "raw.skill/1",
    "raw.stop-continue/1",
    "raw.tool-api/2",
  ]);
  assert.deepEqual(report.prerequisites, ["node"]);
});

test("goal state is workspace-scoped and round-trips atomically", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    assert.equal(api.STATE_VERSION, 1);
    assert.equal(api.MAX_STATE_BYTES, 65536);
    const one = join(root, "one");
    const two = join(root, "two");
    assert.equal(dirname(api.statePath(one, env)), api.stateDir(env));
    assert.match(api.statePath(one, env), /goal-[a-f0-9]{64}\.json$/);
    assert.notEqual(api.statePath(one, env), api.statePath(two, env));
    await api.updateState(one, () => stateFixture(), env);
    const read = await api.readState(one, env) as Record<string, unknown>;
    assert.equal(read.objective, "Ship the fix");
    assert.deepEqual(read.criteria, stateFixture().criteria);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state serializes concurrent writers", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    await Promise.all(Array.from({ length: 10 }, () => api.updateState(root, (state) => ({
      ...state, continuations: Number(state.continuations) + 1,
    }), env)));
    const read = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(read.continuations, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state reports a busy lock instead of stealing it", { timeout: 8000 }, async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    assert.match(api.stateLockPath(root, env), /\.lock\.sqlite$/);
    const lock = new DatabaseSync(api.stateLockPath(root, env));
    try {
      lock.exec("PRAGMA busy_timeout = 0");
      lock.exec("BEGIN IMMEDIATE");
      await assert.rejects(api.updateState(root, (state) => ({ ...state, objective: "blocked" }), env),
        (error: unknown) => (error as { code?: string }).code === "state_busy");
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state rejects corrupt and oversized files", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    const path = api.statePath(root, env);
    writeFileSync(path, "{not json");
    await assert.rejects(api.readState(root, env), (error: unknown) => (error as { code?: string }).code === "state_corrupt");
    writeFileSync(path, "x".repeat(api.MAX_STATE_BYTES + 1));
    await assert.rejects(api.readState(root, env), (error: unknown) => (error as { code?: string }).code === "state_too_large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal kit is documented and changelogged", () => {
  const packages = readFileSync("docs/packages.md", "utf8");
  assert.match(packages, /examples\/packages\/goal-kit\//);
  assert.match(packages, /goal[- ]kit/i);
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  assert.match(changelog, /goal[- ]kit|goal package/i);
});

test("goal tool and hook carry byte-identical state modules", () => {
  const tool = readFileSync(join(ROOT, "tools/goal/state.mjs"), "utf8");
  const hook = readFileSync(join(ROOT, "hooks/goal/state.mjs"), "utf8");
  assert.equal(hook, tool);
});

interface ToolResult {
  isError: boolean;
  code?: string;
  content: Array<{ type: string; text?: string }>;
}

interface GoalTool {
  handler(args: Record<string, unknown>, context: Record<string, unknown>): Promise<ToolResult>;
}

async function goalTool(): Promise<GoalTool> {
  // @ts-expect-error - the shipped package helper is plain .mjs without a declaration file
  return await import("../examples/packages/goal-kit/tools/goal/index.mjs") as unknown as GoalTool;
}

function panelContext(root: string): { context: Record<string, unknown>; updates: Array<{ panel: string; body: Record<string, unknown> }> } {
  const updates: Array<{ panel: string; body: Record<string, unknown> }> = [];
  return {
    updates,
    context: {
      cwd: root,
      maxOutputBytes: 8192,
      panels: {
        update: async (panel: string, body: Record<string, unknown>) => {
          updates.push({ panel, body });
          return { revision: updates.length };
        },
        get: () => undefined,
      },
    },
  };
}

function withStateEnv(root: string, env: NodeJS.ProcessEnv, action: () => Promise<void>): Promise<void> {
  const previous = process.env.RAW_GOAL_STATE_DIR;
  process.env.RAW_GOAL_STATE_DIR = env.RAW_GOAL_STATE_DIR;
  return action().finally(() => {
    if (previous === undefined) delete process.env.RAW_GOAL_STATE_DIR;
    else process.env.RAW_GOAL_STATE_DIR = previous;
  });
}

function toolText(result: ToolResult): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

test("goal tool creates, updates, completes and projects a panel", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context, updates } = panelContext(root);
      const created = await tool.handler({ action: "create", objective: "Ship the fix", doneWhen: "Tests pass",
        criteria: [{ id: "c1", label: "Tests pass" }] }, context);
      assert.equal(created.isError, false, toolText(created));
      const state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.status, "active");
      assert.equal(state.objective, "Ship the fix");
      assert.match(toolText(await tool.handler({ action: "get" }, context)), /Ship the fix/);
      const document = updates.at(-1)?.body.document as Record<string, unknown>;
      assert.equal(document.status, "active");
      assert.equal(document.title, "Ship the fix");
      validateDocument(document);
      assert.deepEqual((document.blocks as Array<Record<string, unknown>>)[0]?.items, [
        { id: "c1", label: "Tests pass", status: "pending" },
      ]);

      const updated = await tool.handler({ action: "update", criteria: [{ id: "c1", status: "done", evidence: "npm test" }] }, context);
      assert.equal(updated.isError, false, toolText(updated));
      const completed = await tool.handler({ action: "complete" }, context);
      assert.equal(completed.isError, false, toolText(completed));
      const finalState = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(finalState.status, "complete");
      const finalDocument = updates.at(-1)?.body.document as Record<string, unknown>;
      assert.equal(finalDocument.status, "done");
      validateDocument(finalDocument);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal tool pauses, resumes, blocks, abandons and clears", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context, updates } = panelContext(root);
      assert.equal((await tool.handler({ action: "create", objective: "Ship", criteria: [{ label: "Tests" }] }, context)).isError, false);
      assert.equal((await tool.handler({ action: "pause", reason: "Need input" }, context)).isError, false);
      assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "paused");
      assert.equal((await tool.handler({ action: "resume" }, context)).isError, false);
      assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "active");
      assert.equal((await tool.handler({ action: "block", reason: "Missing key", nextAction: "Provide key" }, context)).isError, false);
      assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "blocked");
      const blockedText = toolText(await tool.handler({ action: "get" }, context));
      assert.match(blockedText, /Missing key/);
      assert.match(blockedText, /Provide key/);
      const blockedDocument = updates.at(-1)?.body.document as Record<string, unknown>;
      assert.match(String(blockedDocument.context_summary), /Missing key/);
      assert.match(String(blockedDocument.context_summary), /Provide key/);
      assert.equal((await tool.handler({ action: "resume" }, context)).isError, false);
      assert.equal((await tool.handler({ action: "abandon" }, context)).isError, false);
      assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "abandoned");
      assert.equal((await tool.handler({ action: "clear" }, context)).isError, false);
      assert.equal(await api.readState(root, env), undefined);
      const missing = await tool.handler({ action: "get" }, context);
      assert.equal(missing.isError, true);
      assert.equal(missing.code, "no_goal");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume and budget changes keep the cumulative usage baseline", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      await tool.handler({ action: "create", objective: "Ship", criteria: [{ label: "Tests" }],
        maxRequests: 2, tokenBudget: 100 }, context);
      const baseline = { requests: 0, inputTokensKnown: 10, outputTokensKnown: 5, inputCoverage: 1, outputCoverage: 1 };
      await api.updateState(root, (state) => ({ ...state, status: "paused", reason: "user_paused",
        baselinePending: false, usageBaseline: baseline }), env);
      assert.equal((await tool.handler({ action: "resume" }, context)).isError, false);
      let state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.baselinePending, false);
      assert.deepEqual(state.usageBaseline, baseline);
      assert.equal((await tool.handler({ action: "budget", maxRequests: 5 }, context)).isError, false);
      state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.baselinePending, false);
      assert.deepEqual(state.usageBaseline, baseline);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long objective without doneWhen is refused instead of corrupting state", async () => {
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      const long = "x".repeat(600);
      const missing = await tool.handler({ action: "create", objective: long, criteria: [{ label: "Tests" }] }, context);
      assert.equal(missing.code, "invalid_goal");
      const created = await tool.handler({ action: "create", objective: long, doneWhen: "Tests pass", criteria: [{ label: "Tests" }] }, context);
      assert.equal(created.isError, false, toolText(created));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal tool can clear wrong evidence and step detail", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      await tool.handler({ action: "create", objective: "Ship", criteria: [{ label: "Tests" }],
        steps: [{ label: "Run tests" }] }, context);
      assert.equal((await tool.handler({ action: "update",
        criteria: [{ id: "c1", status: "done", evidence: "wrong" }],
        steps: [{ id: "s1", detail: "wrong detail" }] }, context)).isError, false);
      assert.equal((await tool.handler({ action: "update",
        criteria: [{ id: "c1", evidence: "" }],
        steps: [{ id: "s1", detail: "" }] }, context)).isError, false);
      const state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal((state.criteria as Array<Record<string, unknown>>)[0]?.evidence, undefined);
      assert.equal((state.steps as Array<Record<string, unknown>>)[0]?.detail, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a near-limit goal is refused before lifecycle metadata needs the reserved headroom", async () => {
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      const emoji = "😀";
      const criteria = Array.from({ length: 50 }, (_, index) => ({
        id: `c${index + 1}`, label: emoji.repeat(200), required: true, status: "pending", evidence: emoji.repeat(300),
      }));
      const result = await tool.handler({ action: "create", objective: "Ship", criteria }, context);
      assert.equal(result.code, "state_too_large");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a goal just under the content limit can still be paused", async () => {
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      const emoji = "😀";
      const criteria = Array.from({ length: 50 }, (_, index) => ({
        id: `c${index + 1}`, label: emoji.repeat(200), required: true, status: "pending", evidence: emoji.repeat(50),
      }));
      const created = await tool.handler({ action: "create", objective: "Ship", criteria }, context);
      assert.equal(created.isError, false, toolText(created));
      const paused = await tool.handler({ action: "pause", reason: "wait" }, context);
      assert.equal(paused.isError, false, toolText(paused));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the reserved headroom, not only the 64 KiB file limit, bounds the goal content", async () => {
  const api = await stateApi();
  const emoji = "😀";
  const withEvidence = (scalars: number) => ({
    ...stateFixture(),
    criteria: Array.from({ length: 50 }, (_, index) => ({
      id: `c${index + 1}`, label: emoji.repeat(200), required: true, status: "pending", evidence: emoji.repeat(scalars),
    })),
  });
  const contentBytes = (value: Record<string, unknown>) => {
    const { schemaVersion, goalId, objective, doneWhen, criteria, steps, budget } = value;
    return Buffer.byteLength(JSON.stringify({ schemaVersion, goalId, objective, doneWhen, criteria, steps, budget }), "utf8");
  };
  // Content between the reserve line and the file limit: only the reservation can reject it.
  const inBand = withEvidence(100);
  const bandBytes = contentBytes(inBand);
  assert.ok(bandBytes > api.MAX_CONTENT_BYTES && bandBytes < api.MAX_STATE_BYTES - 1024, `band fixture is ${bandBytes} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(inBand), "utf8") <= api.MAX_STATE_BYTES);
  assert.throws(() => api.validateState(inBand), (error: { code?: string; message?: string }) =>
    error.code === "state_too_large" && /goal content/.test(error.message ?? ""));
  // Just under the reserve line, a goal still takes every lifecycle field at its maximum.
  const underBytes = contentBytes(withEvidence(67));
  assert.ok(underBytes <= api.MAX_CONTENT_BYTES && underBytes > api.MAX_CONTENT_BYTES - 4096, `under fixture is ${underBytes} bytes`);
  const lifecycle = {
    ...withEvidence(67), status: "blocked", reason: "r".repeat(300), nextAction: "n".repeat(300), ownerSessionId: "o".repeat(128),
    usageBaseline: { requests: 9e15, inputTokensKnown: 9e15, outputTokensKnown: 9e15, inputCoverage: 9e15, outputCoverage: 9e15 },
    usageCarried: { requests: 9e15, inputTokensKnown: 9e15, outputTokensKnown: 9e15, inputCoverage: 9e15, outputCoverage: 9e15 },
    baselinePending: true, continuations: 9e15, createdAt: 9e15, updatedAt: 9e15,
    usageSeen: Object.fromEntries(Array.from({ length: api.MAX_SEEN_SESSIONS }, (_, index) => [
      `${index}`.padEnd(128, "s"),
      { requests: 9e15, inputTokensKnown: 9e15, outputTokensKnown: 9e15, inputCoverage: 9e15, outputCoverage: 9e15 },
    ])),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(lifecycle), "utf8") <= api.MAX_STATE_BYTES);
  assert.doesNotThrow(() => api.validateState(lifecycle));
});

test("goal tool enforces criteria, ids and terminal transitions", async () => {
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      await tool.handler({ action: "create", objective: "Ship", criteria: [{ id: "c1", label: "Tests" }] }, context);
      assert.equal((await tool.handler({ action: "create", objective: "Again", criteria: [{ label: "Tests" }] }, context)).code, "goal_exists");
      assert.equal((await tool.handler({ action: "complete" }, context)).code, "criteria_incomplete");
      assert.equal((await tool.handler({ action: "update", criteria: [{ id: "nope", status: "done", evidence: "x" }] }, context)).code, "invalid_goal");
      assert.equal((await tool.handler({ action: "update", criteria: [{ id: "c1", status: "done", evidence: "npm test" }],
        steps: [{ label: "a", status: "in_progress" }, { label: "b", status: "in_progress" }] }, context)).code, "invalid_goal");
      assert.equal((await tool.handler({ action: "clear" }, context)).code, "goal_terminal");
      assert.equal((await tool.handler({ action: "abandon" }, context)).isError, false);
      assert.equal((await tool.handler({ action: "pause" }, context)).code, "invalid_goal");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal tool reserves explicit ids before generating new ones", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      const created = await tool.handler({ action: "create", objective: "Ship",
        criteria: [{ label: "Generated" }, { id: "c1", label: "Explicit" }] }, context);
      assert.equal(created.isError, false, toolText(created));
      const state = await api.readState(root, env) as Record<string, unknown>;
      assert.deepEqual((state.criteria as Array<{ id: string }>).map((item) => item.id), ["c2", "c1"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal tool enforces count limits, budget and the panel declaration", async () => {
  const api = await stateApi();
  const tool = await goalTool();
  const { env, root } = tempStateEnv();
  try {
    await withStateEnv(root, env, async () => {
      const { context } = panelContext(root);
      const tooManyCriteria = Array.from({ length: 51 }, (_, index) => ({ label: `Criterion ${index}` }));
      assert.equal((await tool.handler({ action: "create", objective: "Ship", criteria: tooManyCriteria }, context)).code, "goal_limit");
      const tooManySteps = Array.from({ length: 31 }, (_, index) => ({ label: `Step ${index}` }));
      assert.equal((await tool.handler({ action: "create", objective: "Ship", criteria: [{ label: "Tests" }], steps: tooManySteps }, context)).code, "goal_limit");
      assert.equal((await tool.handler({ action: "create", objective: "Ship", criteria: [{ label: "Tests" }],
        tokenBudget: 100, maxRequests: 2, maxContinuations: 3 }, context)).isError, false);
      const state = await api.readState(root, env) as Record<string, unknown>;
      assert.deepEqual(state.budget, { tokenBudget: 100, maxRequests: 2, maxContinuations: 3 });
      assert.equal((await tool.handler({ action: "budget", tokenBudget: null, maxContinuations: 5 }, context)).isError, false);
      const changed = await api.readState(root, env) as Record<string, unknown>;
      assert.deepEqual(changed.budget, { maxRequests: 2, maxContinuations: 5 });
      const manifest = JSON.parse(readFileSync(join(ROOT, "tools/goal/tool.json"), "utf8")) as Record<string, unknown>;
      const panel = (manifest.panels as Array<Record<string, unknown>>)[0]!;
      assert.equal(panel.id, "goal");
      assert.equal(panel.context, "summary");
      assert.deepEqual((panel.actions as Array<Record<string, unknown>>).map((action) => action.id), ["pause", "resume", "complete", "clear"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
