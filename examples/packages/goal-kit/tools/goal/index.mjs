/**
 * The goal kit's model-facing tool. Canonical state is the workspace state file written by
 * state.mjs; the panel is a projection. No Raw source modules are imported.
 */

import { randomUUID } from "node:crypto";
import { readState, updateState, StateError } from "./state.mjs";

const MAX_CRITERIA = 50;
const MAX_STEPS = 30;
const GOAL_CHARS = 80;
const DONE_WHEN_CHARS = 120;
const CONTEXT_SUMMARY_BYTES = 2048;
const ACTIONS = new Set(["create", "get", "update", "complete", "pause", "resume", "block", "abandon", "clear", "budget"]);
const STATUSES = new Set(["pending", "in_progress", "done", "blocked", "skipped"]);
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "complete", "abandoned"]);
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const failure = (code, message) => ({ isError: true, code, content: [{ type: "text", text: message }] });
const clean = (value) => String(value).replace(CONTROL, " ").trim();

function text(value, name, max, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !clean(value)) return `${name} must be a non-empty string`;
  if ([...clean(value)].length > max) return `${name} must be at most ${max} characters`;
  return undefined;
}

function optionalText(value, name, max) {
  if (value === undefined) return undefined;
  return text(value, name, max);
}

function clearableText(value, name, max) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return `${name} must be a string`;
  if (!value.trim()) return undefined;
  return text(value, name, max);
}

function clip(value, limit) {
  const scalars = [...value];
  return scalars.length <= limit ? value : `${scalars.slice(0, limit - 1).join("")}…`;
}

function clipBytes(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "", used = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (used + size > limit - 3) break;
    result += scalar; used += size;
  }
  return `${result}…`;
}

function validateItem(item, kind, mode, ids, at) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return `${at} must be an object`;
  if (item.id !== undefined) {
    if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) return `${at}: id must match ${ITEM_ID.source}`;
    if (ids.has(item.id)) return `${at}: duplicate id "${item.id}"`;
    ids.add(item.id);
  }
  const needsLabel = mode === "create" || item.id === undefined;
  if (needsLabel) {
    const problem = text(item.label, `${at}: label`, 200);
    if (problem) return problem;
  }
  if (item.label !== undefined) {
    const problem = text(item.label, `${at}: label`, 200);
    if (problem) return problem;
  }
  if (item.status !== undefined && !STATUSES.has(item.status)) return `${at}: unknown status "${String(item.status)}"`;
  if (kind === "criteria") {
    if (item.required !== undefined && typeof item.required !== "boolean") return `${at}: required must be boolean`;
    const problem = clearableText(item.evidence, `${at}: evidence`, 300);
    if (problem) return problem;
  } else {
    const problem = clearableText(item.detail, `${at}: detail`, 200);
    if (problem) return problem;
  }
  return undefined;
}

export function validateArgs(args) {
  const value = args ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  if (typeof value.action !== "string" || !ACTIONS.has(value.action)) return `action must be one of ${[...ACTIONS].join(", ")}`;
  const allowed = {
    create: ["objective", "doneWhen", "criteria", "steps", "tokenBudget", "maxRequests", "maxContinuations"],
    get: [],
    update: ["criteria", "steps"],
    complete: [],
    pause: ["reason"],
    resume: [],
    block: ["reason", "nextAction"],
    abandon: [],
    clear: [],
    budget: ["tokenBudget", "maxRequests", "maxContinuations"],
  }[value.action];
  for (const key of Object.keys(value)) {
    if (key !== "action" && !allowed.includes(key)) return `${key} is not allowed with ${value.action}`;
  }
  if (value.action === "create") {
    const problem = text(value.objective, "objective", 2000);
    if (problem) return problem;
    if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > MAX_CRITERIA) {
      return `criteria must contain 1..${MAX_CRITERIA} items`;
    }
    if (value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS)) {
      return `steps must contain at most ${MAX_STEPS} items`;
    }
    if (value.doneWhen !== undefined) {
      const done = text(value.doneWhen, "doneWhen", 500);
      if (done) return done;
    }
    const ids = new Set();
    let required = 0;
    for (const [index, item] of value.criteria.entries()) {
      const problem = validateItem(item, "criteria", "create", ids, `criteria[${index}]`);
      if (problem) return problem;
      if (item.required !== false) required++;
    }
    for (const [index, item] of (value.steps ?? []).entries()) {
      const problem = validateItem(item, "steps", "create", ids, `steps[${index}]`);
      if (problem) return problem;
    }
    if (!required) return "at least one required criterion is required";
  }
  if (value.action === "update") {
    if (value.criteria === undefined && value.steps === undefined) return "update needs criteria or steps";
    if (value.criteria !== undefined && (!Array.isArray(value.criteria) || value.criteria.length > MAX_CRITERIA)) {
      return `criteria must contain at most ${MAX_CRITERIA} items`;
    }
    if (value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS)) {
      return `steps must contain at most ${MAX_STEPS} items`;
    }
    const ids = new Set();
    for (const [index, item] of (value.criteria ?? []).entries()) {
      const problem = validateItem(item, "criteria", "update", ids, `criteria[${index}]`);
      if (problem) return problem;
    }
    for (const [index, item] of (value.steps ?? []).entries()) {
      const problem = validateItem(item, "steps", "update", ids, `steps[${index}]`);
      if (problem) return problem;
    }
  }
  if (value.action === "block") {
    for (const name of ["reason", "nextAction"]) {
      const problem = text(value[name], name, 300);
      if (problem) return problem;
    }
  } else if (value.action === "pause") {
    const problem = optionalText(value.reason, "reason", 300);
    if (problem) return problem;
  }
  if (value.action === "budget") {
    if (value.tokenBudget === undefined && value.maxRequests === undefined && value.maxContinuations === undefined) {
      return "budget needs tokenBudget, maxRequests or maxContinuations";
    }
    for (const name of ["tokenBudget", "maxRequests"]) {
      if (value[name] !== undefined && value[name] !== null && (!Number.isSafeInteger(value[name]) || value[name] < 1)) {
        return `${name} must be a positive integer or null`;
      }
    }
    if (value.maxContinuations !== undefined && (!Number.isSafeInteger(value.maxContinuations) || value.maxContinuations < 1 || value.maxContinuations > 100)) {
      return "maxContinuations must be an integer from 1 to 100";
    }
  }
  if (value.action === "create") for (const name of ["tokenBudget", "maxRequests"]) {
    if (value[name] !== undefined && value[name] !== null && (!Number.isSafeInteger(value[name]) || value[name] < 1)) return `${name} must be a positive integer`;
  }
  if (value.maxContinuations !== undefined && (!Number.isSafeInteger(value.maxContinuations) || value.maxContinuations < 1 || value.maxContinuations > 100)) {
    return "maxContinuations must be an integer from 1 to 100";
  }
  return undefined;
}

function idsFor(items, prefix, used) {
  let next = 1;
  return items.map((item) => {
    let id = item.id;
    if (id === undefined) {
      while (used.has(`${prefix}${next}`)) next++;
      id = `${prefix}${next}`;
    }
    used.add(id);
    return { ...item, id };
  });
}

function fromCreate(item, kind) {
  const base = { id: item.id, label: clean(item.label), status: item.status ?? "pending" };
  if (kind === "criteria") {
    base.required = item.required !== false;
    if (item.evidence !== undefined && clean(item.evidence)) base.evidence = clean(item.evidence);
  } else if (item.detail !== undefined && clean(item.detail)) {
    base.detail = clean(item.detail);
  }
  return base;
}

function oneStepInProgress(steps) {
  const running = steps.filter((step) => step.status === "in_progress");
  if (running.length > 1) throw new StateError("invalid_goal", "at most one step may be in_progress");
}

function mutate(state, { action, value }) {
  const now = Date.now();
  if (action === "create") {
    if (state) throw new StateError("goal_exists", "clear the current goal before starting another");
    const objective = clean(value.objective);
    const doneWhen = value.doneWhen === undefined
      ? ([...objective].length <= 500 ? objective : (() => { throw new StateError("invalid_goal", "doneWhen is required when objective exceeds 500 characters"); })())
      : clean(value.doneWhen);
    const rawCriteria = actionCriteria(value);
    const rawSteps = actionSteps(value);
    // Reserve every explicit id before generating any missing one, so a generated id can never
    // collide with an explicit id that appears later in the list.
    const used = new Set([...rawCriteria, ...rawSteps].flatMap((item) => item.id === undefined ? [] : [item.id]));
    const criteria = idsFor(rawCriteria, "c", used).map((item) => fromCreate(item, "criteria"));
    const steps = idsFor(rawSteps, "s", used).map((item) => fromCreate(item, "steps"));
    oneStepInProgress(steps);
    return {
      schemaVersion: 1,
      goalId: randomUUID(),
      status: "active",
      objective,
      doneWhen,
      criteria,
      steps,
      budget: {
        ...(value.tokenBudget === undefined || value.tokenBudget === null ? {} : { tokenBudget: value.tokenBudget }),
        ...(value.maxRequests === undefined || value.maxRequests === null ? {} : { maxRequests: value.maxRequests }),
        maxContinuations: value.maxContinuations ?? 20,
      },
      baselinePending: true,
      usageCarried: { requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 },
      continuations: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (!state) throw new StateError("no_goal", "there is no goal yet; create one first");
  const next = structuredClone(state);
  if (action === "update") {
    if (next.status !== "active") throw new StateError("invalid_goal", "only an active goal can receive progress");
    const used = new Set([...next.criteria, ...next.steps].map((item) => item.id));
    applyUpdates(next.criteria, value.criteria ?? [], "criteria", "c", used);
    applyUpdates(next.steps, value.steps ?? [], "steps", "s", used);
    if (next.criteria.length > MAX_CRITERIA) throw new StateError("goal_limit", `criteria: at most ${MAX_CRITERIA}`);
    if (next.steps.length > MAX_STEPS) throw new StateError("goal_limit", `steps: at most ${MAX_STEPS}`);
    oneStepInProgress(next.steps);
  } else if (action === "complete") {
    if (next.status !== "active") throw new StateError("invalid_goal", "only an active goal can be completed");
    const required = next.criteria.filter((item) => item.required);
    if (!required.length || required.some((item) => item.status !== "done" || !item.evidence?.trim())) {
      throw new StateError("criteria_incomplete", "every required criterion must be done with evidence");
    }
    next.status = "complete";
    delete next.reason; delete next.nextAction;
  } else if (action === "pause") {
    if (next.status !== "active") throw new StateError("invalid_goal", "only an active goal can be paused");
    next.status = "paused";
    next.reason = clean(value.reason ?? "user_paused");
    delete next.nextAction;
  } else if (action === "resume") {
    if (next.status !== "paused" && next.status !== "blocked") throw new StateError("invalid_goal", "only a paused or blocked goal can resume");
    next.status = "active";
    delete next.reason; delete next.nextAction;
  } else if (action === "block") {
    if (next.status !== "active") throw new StateError("invalid_goal", "only an active goal can block");
    next.status = "blocked";
    next.reason = clean(value.reason);
    next.nextAction = clean(value.nextAction);
  } else if (action === "abandon") {
    if (next.status === "complete" || next.status === "abandoned") throw new StateError("goal_terminal", "the goal is already closed");
    next.status = "abandoned";
    next.reason = "user_abandoned";
    delete next.nextAction;
  } else if (action === "budget") {
    if (next.status === "complete" || next.status === "abandoned") throw new StateError("goal_terminal", "the goal is already closed");
    if (value.tokenBudget !== undefined) {
      if (value.tokenBudget === null) delete next.budget.tokenBudget;
      else next.budget.tokenBudget = value.tokenBudget;
    }
    if (value.maxRequests !== undefined) {
      if (value.maxRequests === null) delete next.budget.maxRequests;
      else next.budget.maxRequests = value.maxRequests;
    }
    if (value.maxContinuations !== undefined) next.budget.maxContinuations = value.maxContinuations;
  } else if (action === "clear") {
    if (next.status !== "complete" && next.status !== "abandoned") throw new StateError("goal_terminal", "abandon or complete the goal before clearing it");
    return undefined;
  } else {
    throw new StateError("invalid_goal", "unknown action");
  }
  next.updatedAt = now;
  return next;
}

function actionCriteria(value) {
  return Array.isArray(value.criteria) ? value.criteria : [];
}

function actionSteps(value) {
  return Array.isArray(value.steps) ? value.steps : [];
}

function applyUpdates(items, changes, kind, prefix, used) {
  for (const change of changes) {
    if (change.id === undefined) {
      const id = (() => {
        let index = 1;
        while (used.has(`${prefix}${index}`)) index++;
        used.add(`${prefix}${index}`);
        return `${prefix}${index}`;
      })();
      items.push(fromCreate({ ...change, id }, kind));
      continue;
    }
    const target = items.find((item) => item.id === change.id);
    if (!target) throw new StateError("invalid_goal", `unknown ${kind} id "${change.id}"`);
    if (change.label !== undefined && clean(change.label) !== target.label) {
      throw new StateError("invalid_goal", "the goal definition is fixed; update only status and evidence");
    }
    if (kind === "criteria" && change.required !== undefined && change.required !== target.required) {
      throw new StateError("invalid_goal", "the goal definition is fixed; update only status and evidence");
    }
    if (change.status !== undefined) target.status = change.status;
    if (kind === "criteria" && change.evidence !== undefined) {
      if (clean(change.evidence)) target.evidence = clean(change.evidence);
      else delete target.evidence;
    }
    if (kind === "steps" && change.detail !== undefined) {
      if (clean(change.detail)) target.detail = clean(change.detail);
      else delete target.detail;
    }
  }
}

function panelStatus(state) {
  if (state.status === "complete") return "done";
  if (state.status === "abandoned") return "failed";
  if (state.status === "active") return "active";
  return "idle";
}

function panelDocument(state) {
  const met = state.criteria.filter((item) => item.status === "done").length;
  const blocks = [{
    id: "criteria", kind: "checklist", title: "Acceptance criteria",
    items: state.criteria.map(({ id, label, status, evidence }) => ({ id, label, status, ...(evidence ? { note: evidence } : {}) })),
  }];
  if (state.steps.length) {
    blocks.push({ id: "steps", kind: "steps", title: "Steps",
      items: state.steps.map(({ id, label, status, detail }) => ({ id, label, status, ...(detail ? { detail } : {}) })) });
  }
  const open = state.criteria.filter((item) => item.status !== "done" && item.status !== "skipped");
  return {
    title: clip(state.objective, GOAL_CHARS),
    subtitle: clip(state.reason ? `${state.doneWhen} — ${state.reason}` : state.doneWhen, DONE_WHEN_CHARS),
    status: panelStatus(state),
    progress: { done: met, total: state.criteria.length },
    blocks,
    context_summary: clipBytes([
      `Goal (${state.status}): ${state.objective}`,
      `Done when: ${state.doneWhen}`,
      ...state.reason ? [`Reason: ${state.reason}`] : [],
      ...state.nextAction ? [`Next action: ${state.nextAction}`] : [],
      `Criteria: ${met}/${state.criteria.length} done${open.length ? `; open: ${open.map((item) => item.label).join("; ")}` : ""}`,
      budgetLine(state),
    ].join("\n"), CONTEXT_SUMMARY_BYTES),
  };
}

function budgetLine(state) {
  const budget = state.budget;
  return `Budget: continuations ${state.continuations}/${budget.maxContinuations}` +
    (budget.maxRequests === undefined ? "" : `, requests ≤ ${budget.maxRequests}`) +
    (budget.tokenBudget === undefined ? "" : `, tokens ≤ ${budget.tokenBudget}`);
}

function summary(state) {
  const met = state.criteria.filter((item) => item.status === "done").length;
  return [
    `Goal (${state.status}): ${state.objective}`,
    `Done when: ${state.doneWhen}`,
    ...state.reason ? [`Reason: ${state.reason}`] : [],
    ...state.nextAction ? [`Next action: ${state.nextAction}`] : [],
    budgetLine(state),
    `Criteria (${met}/${state.criteria.length} done):`,
    ...state.criteria.map((item) => `- [${item.status === "done" ? "x" : item.status === "skipped" ? "-" : " "}] ${item.id} ${item.label}${item.evidence ? ` — ${item.evidence}` : ""}`),
    ...state.steps.length ? ["Steps:", ...state.steps.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.id} ${item.label}`)] : [],
  ].join("\n");
}

async function syncPanel(context, state, warnings) {
  if (!context.panels) return;
  try {
    if (!state) await context.panels.update("goal", { op: "close" });
    else await context.panels.update("goal", { op: "replace", document: panelDocument(state) });
  } catch (error) {
    warnings.push(`panel update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function handler(args, context) {
  const value = args ?? {};
  if (!context?.cwd) return failure("state_error", "the tool has no workspace");
  if (Array.isArray(value.criteria) && value.criteria.length > MAX_CRITERIA) return failure("goal_limit", `criteria: at most ${MAX_CRITERIA}`);
  if (Array.isArray(value.steps) && value.steps.length > MAX_STEPS) return failure("goal_limit", `steps: at most ${MAX_STEPS}`);
  const invalid = validateArgs(value);
  if (invalid) return failure("invalid_goal", invalid);
  const warnings = [];
  try {
    if (value.action === "get") {
      const state = await readState(context.cwd);
      if (!state) return failure("no_goal", "there is no goal yet");
      await syncPanel(context, state, warnings);
      return { isError: false, content: [{ type: "text", text: [summary(state), ...warnings].join("\n") }] };
    }
    let state;
    if (value.action === "clear") {
      state = await updateState(context.cwd, (before) => {
        if (!before) throw new StateError("no_goal", "there is no goal yet");
        return mutate(before, { action: "clear", value });
      });
    } else {
      state = await updateState(context.cwd, (before) => mutate(before, { action: value.action, value }));
    }
    await syncPanel(context, state, warnings);
    if (!state) return { isError: false, content: [{ type: "text", text: ["Goal cleared.", ...warnings].join("\n") }] };
    return { isError: false, content: [{ type: "text", text: [summary(state), ...warnings].join("\n") }] };
  } catch (error) {
    if (error instanceof StateError) return failure(error.code, error.message);
    return failure("state_error", error instanceof Error ? error.message : String(error));
  }
}
