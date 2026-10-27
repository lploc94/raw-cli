import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/hooks/runner.js";
import { skillInstruction } from "../web/src/composer/commands.js";
import type { HookExecution, HookRequest, SelectedHook } from "../src/hooks/contract.js";

const ROOT = "examples/packages/goal-kit";
const HOOK_DIR = join(ROOT, "hooks/goal");

interface StateApi {
  statePath(cwd: string, env?: NodeJS.ProcessEnv): string;
  readState(cwd: string, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined>;
  updateState(cwd: string, mutate: (state: Record<string, unknown> | undefined) => Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<unknown>;
  deleteState(cwd: string, env?: NodeJS.ProcessEnv): Promise<void>;
}

async function stateApi(): Promise<StateApi> {
  // @ts-expect-error - the shipped package helper is plain .mjs without a declaration file
  return await import("../examples/packages/goal-kit/tools/goal/state.mjs") as unknown as StateApi;
}

function stateFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    goalId: "00000000-0000-4000-8000-000000000001",
    ownerSessionId: "s1",
    status: "active",
    objective: "Ship the fix",
    doneWhen: "The tests pass",
    criteria: [{ id: "c1", label: "Tests pass", required: true, status: "pending" }],
    steps: [],
    budget: { maxContinuations: 3 },
    baselinePending: true,
    usageBaseline: undefined,
    continuations: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requests: 1,
    inputTokensKnown: 10,
    inputCoverage: 1,
    outputTokensKnown: 5,
    outputCoverage: 1,
    cacheReadTokensKnown: 0,
    cacheWriteTokensKnown: 0,
    cacheReadCoverage: 0,
    cacheWriteCoverage: 0,
    cacheRatioCoverage: 0,
    ...overrides,
  };
}

function selectedHook(): SelectedHook {
  const folder = resolve(HOOK_DIR);
  return {
    protocol_version: 2,
    id: "agent/goal",
    name: "goal",
    folder,
    command: process.execPath,
    args: [join(folder, "index.mjs")],
    timeoutMs: 5000,
    events: [{ name: "Stop" }, { name: "SessionStart" }, { name: "UserPromptSubmit" }],
  };
}

function stopRequest(root: string, session: string, options: {
  status?: string;
  continuations?: number;
  usage?: Record<string, unknown>;
} = {}): HookRequest {
  return {
    protocol_version: 2,
    event: "Stop",
    cwd: root,
    session_id: session,
    run: { status: options.status ?? "completed", steps: 1, text: "done" },
    stop: { hook_active: false, continuations: options.continuations ?? 0, usage: (options.usage ?? usage()) as never },
  };
}

function eventRequest(root: string, event: "SessionStart" | "UserPromptSubmit", session: string, source?: "create" | "resume", input = "next"): HookRequest {
  return { protocol_version: 2, event, cwd: root, session_id: session, ...(source ? { source } : {}), ...(event === "UserPromptSubmit" ? { input } : {}) };
}

async function invoke(request: HookRequest, env: NodeJS.ProcessEnv): Promise<HookExecution> {
  return runHook(selectedHook(), request, { env, timeoutMs: 5000 });
}

function tempEnv(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-hooks-"));
  return { root, env: { ...process.env, RAW_GOAL_STATE_DIR: join(root, "state") } };
}

test("Stop continues an active goal and claims the session", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({ ownerSessionId: undefined }), env);
    const result = await invoke(stopRequest(root, "s1"), env);
    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", /Ship the fix/);
    const state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.ownerSessionId, "s1");
    assert.equal(state.continuations, 1);
    assert.equal(state.baselinePending, false);
    assert.deepEqual(state.usageBaseline, {
      requests: 1, inputTokensKnown: 10, outputTokensKnown: 5, inputCoverage: 1, outputCoverage: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first Stop counts what the session already spent against an explicit budget", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    const cases = [
      { budget: { maxRequests: 1, maxContinuations: 20 }, reason: "request_budget_exhausted" },
      { budget: { tokenBudget: 10, maxContinuations: 20 }, reason: "token_budget_exhausted" },
    ];
    for (const { budget, reason } of cases) {
      await api.updateState(root, () => stateFixture({ budget }), env);
      const result = await invoke(stopRequest(root, "s1", { usage: usage({
        requests: 5, inputTokensKnown: 50, outputTokensKnown: 25, inputCoverage: 5, outputCoverage: 5,
      }) }), env);
      assert.notEqual(result.decision, "deny", reason);
      const state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.status, "paused", reason);
      assert.equal(state.reason, reason);
      assert.equal((state.usageCarried as Record<string, unknown>).requests, 5, reason);
      await api.deleteState(root, env);
    }
    // Within budget the same first Stop still continues.
    await api.updateState(root, () => stateFixture({ budget: { maxRequests: 10, tokenBudget: 1000, maxContinuations: 20 } }), env);
    assert.equal((await invoke(stopRequest(root, "s1", { usage: usage({ requests: 5, inputCoverage: 5, outputCoverage: 5 }) }), env)).decision, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop pauses at the continuation cap and lets closed goals end", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({ continuations: 3, budget: { maxContinuations: 3 } }), env);
    assert.equal((await invoke(stopRequest(root, "s1"), env)).decision, "continue");
    const capped = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(capped.status, "paused");
    assert.equal(capped.reason, "continuation_limit");

    for (const status of ["complete", "abandoned", "paused"] as const) {
      await api.updateState(root, () => stateFixture({ status }), env);
      assert.equal((await invoke(stopRequest(root, "s1"), env)).decision, "continue", status);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop pauses non-completed runs and leaves another session's goal alone", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    const foreign = await invoke(stopRequest(root, "s2", { status: "error" }), env);
    assert.equal(foreign.decision, "continue");
    assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "active");

    await invoke(stopRequest(root, "s1", { status: "error" }), env);
    const paused = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "run_error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop pauses on request and token budgets and on unknown usage", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    const baseline = { requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 };
    await api.updateState(root, () => stateFixture({ budget: { maxRequests: 2, maxContinuations: 20 }, baselinePending: false, usageBaseline: baseline }), env);
    await invoke(stopRequest(root, "s1", { usage: usage({ requests: 2 }) }), env);
    let state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.reason, "request_budget_exhausted");

    await api.updateState(root, () => stateFixture({ budget: { tokenBudget: 10, maxContinuations: 20 }, baselinePending: false, usageBaseline: baseline }), env);
    await invoke(stopRequest(root, "s1", { usage: usage({ requests: 2, inputCoverage: 1 }) }), env);
    state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.reason, "usage_unknown");

    await api.updateState(root, () => stateFixture({ budget: { tokenBudget: 10, maxContinuations: 20 }, baselinePending: false, usageBaseline: baseline }), env);
    await invoke(stopRequest(root, "s1", { usage: usage({ requests: 1, inputTokensKnown: 10, outputTokensKnown: 5 }) }), env);
    state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.reason, "token_budget_exhausted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart transfers ownership of paused and blocked goals", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    for (const status of ["paused", "blocked"] as const) {
      await api.updateState(root, () => stateFixture({ status, reason: status === "paused" ? "Need input" : "Missing key",
        nextAction: status === "blocked" ? "Provide key" : undefined, ownerSessionId: "s1" }), env);
      await invoke(eventRequest(root, "SessionStart", "s2", "resume"), env);
      let state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.status, status);
      assert.equal(state.ownerSessionId, "s2");
      assert.equal(state.reason, status === "paused" ? "Need input" : "Missing key");
      await api.updateState(root, (current) => ({ ...current, status: "active" }), env);
      assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 1 }) }), env)).decision, "deny", status);
      state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.continuations, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership takeover rebases session-relative usage without resetting spending", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({
      budget: { maxRequests: 2, maxContinuations: 20 },
      baselinePending: false,
      usageBaseline: { requests: 100, inputTokensKnown: 10000, outputTokensKnown: 1000, inputCoverage: 100, outputCoverage: 100 },
    }), env);
    await invoke(eventRequest(root, "SessionStart", "s2", "resume"), env);
    let state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.baselinePending, true);
    assert.equal(state.usageBaseline, undefined);
    await api.updateState(root, (current) => ({ ...current, status: "active" }), env);
    // The new session counts from its own start: its first final answer already spent one request.
    assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 1 }) }), env)).decision, "deny");
    assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 2 }) }), env)).decision, "continue");
    state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.status, "paused");
    assert.equal(state.reason, "request_budget_exhausted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session that takes the goal back is not charged for what it already spent", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({ budget: { maxRequests: 12, maxContinuations: 20 } }), env);
    const resume = async (session: string) => {
      await invoke(eventRequest(root, "SessionStart", session, "resume"), env);
      await api.updateState(root, (current) => ({ ...current, status: "active" }), env);
    };
    const carried = async () => ((await api.readState(root, env))?.usageCarried as Record<string, number>).requests;
    assert.equal((await invoke(stopRequest(root, "s1", { usage: usage({ requests: 6 }) }), env)).decision, "deny");
    await resume("s2");
    assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 2 }) }), env)).decision, "deny");
    assert.equal(await carried(), 8);
    // s1 returns: its session counter kept growing from 6, so only the new request counts.
    await resume("s1");
    assert.equal((await invoke(stopRequest(root, "s1", { usage: usage({ requests: 7 }) }), env)).decision, "deny");
    assert.equal(await carried(), 9);
    await resume("s2");
    assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 4 }) }), env)).decision, "deny");
    // s2 had reported 2 before; its counter is now 4, so two more requests count.
    assert.equal(await carried(), 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the most recent owners keep a usage watermark", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({ budget: { maxContinuations: 100 } }), env);
    for (let index = 1; index <= 20; index++) {
      await invoke(eventRequest(root, "SessionStart", `s${index}`, "resume"), env);
      await api.updateState(root, (current) => ({ ...current, status: "active" }), env);
      await invoke(stopRequest(root, `s${index}`, { usage: usage({ requests: 1 }) }), env);
    }
    const state = await api.readState(root, env) as Record<string, unknown>;
    const seen = Object.keys(state.usageSeen as Record<string, unknown>);
    assert.equal(seen.length, 16);
    assert.ok(!seen.includes("s20") && seen.includes("s19") && !seen.includes("s3") && seen.includes("s4"), seen.join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paused and blocked goals record the final run before ownership transfer", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    for (const status of ["paused", "blocked"] as const) {
      await api.updateState(root, () => stateFixture({
        status,
        reason: status === "paused" ? "Need input" : "Missing key",
        nextAction: status === "blocked" ? "Provide key" : undefined,
        ownerSessionId: "s1",
        budget: { maxRequests: 2, maxContinuations: 20 },
        baselinePending: false,
        usageBaseline: { requests: 100, inputTokensKnown: 10000, outputTokensKnown: 1000, inputCoverage: 100, outputCoverage: 100 },
        usageCarried: { requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 },
      }), env);
      await invoke(stopRequest(root, "s1", { status: "completed", usage: usage({ requests: 103 }) }), env);
      let state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal((state.usageCarried as Record<string, unknown>).requests, 3, status);
      await invoke(eventRequest(root, "SessionStart", "s2", "resume"), env);
      state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.ownerSessionId, "s2");
      assert.equal((state.usageCarried as Record<string, unknown>).requests, 3);
      assert.equal(state.baselinePending, true);
      await api.updateState(root, (current) => ({ ...current, status: "active" }), env);
      assert.equal((await invoke(stopRequest(root, "s2", { usage: usage({ requests: 1 }) }), env)).decision, "continue", status);
      state = await api.readState(root, env) as Record<string, unknown>;
      assert.equal(state.reason, "request_budget_exhausted");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token coverage is measured from the baseline, not the whole session", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({
      budget: { tokenBudget: 100, maxContinuations: 20 },
      baselinePending: false,
      usageBaseline: { requests: 2, inputTokensKnown: 10, outputTokensKnown: 5, inputCoverage: 1, outputCoverage: 1 },
    }), env);
    const result = await invoke(stopRequest(root, "s1", { usage: usage({
      requests: 3, inputTokensKnown: 10, outputTokensKnown: 5, inputCoverage: 2, outputCoverage: 2,
    }) }), env);
    assert.equal(result.decision, "deny");
    assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart takes over an active goal from a dead owner", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture({ ownerSessionId: "s1" }), env);
    await invoke(eventRequest(root, "SessionStart", "s2", "resume"), env);
    const state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.status, "paused");
    assert.equal(state.reason, "interrupted");
    assert.equal(state.ownerSessionId, "s2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart and UserPromptSubmit pause an active goal instead of treating it as consent", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    assert.equal((await invoke(eventRequest(root, "SessionStart", "s1", "resume"), env)).decision, "continue");
    let state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.status, "paused");
    assert.equal(state.reason, "interrupted");

    await api.updateState(root, () => stateFixture(), env);
    assert.equal((await invoke(eventRequest(root, "UserPromptSubmit", "s1"), env)).decision, "continue");
    state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.status, "paused");
    assert.equal(state.reason, "user_message");

    await api.updateState(root, () => stateFixture({ ownerSessionId: "s1" }), env);
    await invoke(eventRequest(root, "UserPromptSubmit", "s2"), env);
    assert.equal((await api.readState(root, env) as Record<string, unknown>).status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a /goal command does not pause the active goal", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    assert.equal((await invoke(eventRequest(root, "UserPromptSubmit", "s1", undefined, "/goal status"), env)).decision, "continue");
    const state = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(state.status, "active");
    assert.equal(state.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the prompt the composer inserts for the goal skill does not pause the goal, near misses do", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    const composer = skillInstruction("goal");
    const exempt: Array<string | Array<{ type: string; text: string }>> = [
      `${composer}status`, composer, `  ${composer}\nstatus`, [{ type: "text", text: `${composer}status` }],
    ];
    const ordinary = [`${skillInstruction("goals")}status`, "/goals status", "please use the skill \"goal\" for this task. status", "next"];
    for (const [inputs, paused] of [[exempt, false], [ordinary, true]] as const) {
      for (const input of inputs) {
        await api.updateState(root, () => stateFixture(), env);
        const result = await runHook(selectedHook(), { protocol_version: 2, event: "UserPromptSubmit", cwd: root, session_id: "s1", input } as HookRequest, { env, timeoutMs: 5000 });
        assert.equal(result.decision, "continue");
        const state = await api.readState(root, env) as Record<string, unknown>;
        assert.equal(state.status, paused ? "paused" : "active", JSON.stringify(input));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt state never traps a run or a prompt", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    writeFileSync(api.statePath(root, env), "{not json");
    assert.equal((await invoke(stopRequest(root, "s1"), env)).decision, "continue");
    assert.equal((await invoke(eventRequest(root, "UserPromptSubmit", "s1"), env)).decision, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long Stop reason stays inside the host bound and keeps the objective first", async () => {
  const api = await stateApi();
  const { root, env } = tempEnv();
  try {
    const criteria = Array.from({ length: 50 }, (_, index) => ({ id: `c${index + 1}`, label: `Criterion ${index + 1} `.repeat(8), required: true, status: "pending" }));
    await api.updateState(root, () => stateFixture({ objective: `Objective ${"x".repeat(1900)}`, criteria }), env);
    const result = await invoke(stopRequest(root, "s1"), env);
    assert.equal(result.decision, "deny");
    assert.ok(Buffer.byteLength(result.reason ?? "", "utf8") <= 8192);
    assert.match(result.reason ?? "", /^Goal: Objective /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal hook manifest subscribes to Stop, SessionStart and UserPromptSubmit", () => {
  const manifest = JSON.parse(readFileSync(join(HOOK_DIR, "hook.json"), "utf8")) as { events: Array<{ name: string }>; command: string };
  assert.deepEqual(manifest.events.map((event) => event.name), ["Stop", "SessionStart", "UserPromptSubmit"]);
  assert.equal(manifest.command, "node");
});
