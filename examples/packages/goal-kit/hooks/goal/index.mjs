/**
 * One package hook for the goal kit.
 *
 * Stop: deny while the goal is active, under budget and under the continuation cap. The host
 * (raw.stop-continue/1) then adds the reason as a host message and makes one more request.
 * SessionStart: pause an interrupted goal so a restart never continues by itself.
 * UserPromptSubmit: pause an active goal so an ordinary user message is not consent to continue.
 *
 * Every path is fail-open for observations and never blocks a user prompt. A corrupt or locked
 * state file ends the run (or lets the prompt through) instead of trapping it.
 */

import { MAX_SEEN_SESSIONS, readState, updateState } from "./state.mjs";

const MAX_REASON_BYTES = 8 * 1024;
// `/goal ...` typed literally, or the prompt the dashboard composer inserts when the goal skill is
// chosen (`skillInstruction` in web/src/composer/commands.ts). Neither is an ordinary user message.
const GOAL_COMMAND = /^(?:\/goal|Use the skill "goal" for this task\.)(?:\s|$)/;
const DEFAULT_REASON = "Continue toward the goal.";

function output(value) {
  process.stdout.write(JSON.stringify(value));
}

function message(text) {
  if (Buffer.byteLength(text, "utf8") <= 512) output({ message: text });
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

function usageOf(request) {
  const usage = request.stop?.usage ?? {};
  const number = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    requests: number(usage.requests),
    inputTokensKnown: number(usage.inputTokensKnown),
    outputTokensKnown: number(usage.outputTokensKnown),
    inputCoverage: number(usage.inputCoverage),
    outputCoverage: number(usage.outputCoverage),
  };
}

const zeroUsage = () => ({ requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 });

function totalUsage(state, usage) {
  const baseline = state.usageBaseline ?? zeroUsage();
  const carried = state.usageCarried ?? zeroUsage();
  const delta = (name) => Math.max(0, usage[name] - baseline[name]);
  return {
    requests: carried.requests + delta("requests"),
    inputTokensKnown: carried.inputTokensKnown + delta("inputTokensKnown"),
    outputTokensKnown: carried.outputTokensKnown + delta("outputTokensKnown"),
    inputCoverage: carried.inputCoverage + delta("inputCoverage"),
    outputCoverage: carried.outputCoverage + delta("outputCoverage"),
  };
}

function budgetReason(state, usage) {
  const budget = state.budget ?? {};
  const total = totalUsage(state, usage);
  if (budget.maxRequests !== undefined && total.requests >= budget.maxRequests) {
    return "request_budget_exhausted";
  }
  if (budget.tokenBudget !== undefined) {
    if (total.inputCoverage < total.requests || total.outputCoverage < total.requests) return "usage_unknown";
    if (total.inputTokensKnown + total.outputTokensKnown >= budget.tokenBudget) return "token_budget_exhausted";
  }
  return undefined;
}

/**
 * Record everything observed so far, then make the current session counters the new delta base.
 * A pending baseline is zero: the tool cannot see usage when it creates the goal, so the first
 * Stop counts the whole owning session rather than silently dropping what was already spent.
 */
function recordUsage(state, usage) {
  if (!state.usageBaseline || state.baselinePending) state.usageBaseline = zeroUsage();
  state.usageCarried = totalUsage(state, usage);
  state.usageBaseline = { ...usage };
  state.baselinePending = false;
}

function reasonFor(state) {
  const criteria = state.criteria.map((item) => {
    const mark = item.status === "done" ? "x" : item.status === "skipped" ? "-" : " ";
    return `- [${mark}] ${item.id} ${item.label}${item.required ? " (required)" : ""}`;
  });
  const allDone = state.criteria.filter((item) => item.required)
    .every((item) => item.status === "done" && item.evidence?.trim());
  const text = [
    `Goal: ${state.objective}`,
    `Status: ${state.status}`,
    `Done when: ${state.doneWhen}`,
    "Criteria:",
    ...criteria,
    ...state.steps.length ? ["Steps:", ...state.steps.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.id} ${item.label}`)] : [],
    allDone
      ? "Every required criterion is done. Call goal complete now."
      : "Continue toward this goal. To ask the user for input, call goal pause with a reason first. Do not change the objective or budget.",
  ].join("\n");
  return clipBytes(text || DEFAULT_REASON, MAX_REASON_BYTES);
}

function sessionOf(request) {
  return typeof request.session_id === "string" && request.session_id.trim() ? request.session_id : undefined;
}

function inputText(request) {
  if (typeof request.input === "string") return request.input;
  if (!Array.isArray(request.input)) return "";
  return request.input.map((block) => block && typeof block === "object" && typeof block.text === "string" ? block.text : "").join("\n");
}

/**
 * Hand the goal to another session. The usage of a session is cumulative, so each owner keeps the
 * watermark it last reported: a session that has never counted toward this goal starts at zero, and
 * one that returns continues from where it stopped instead of being charged twice.
 */
function handOver(state, session) {
  const seen = { ...state.usageSeen };
  const previous = state.ownerSessionId;
  if (previous && state.usageBaseline && !state.baselinePending) {
    delete seen[previous];
    seen[previous] = state.usageBaseline;
  }
  const known = seen[session];
  delete seen[session];
  const extra = Object.keys(seen).length - MAX_SEEN_SESSIONS;
  for (const key of Object.keys(seen).slice(0, Math.max(0, extra))) delete seen[key];
  if (Object.keys(seen).length) state.usageSeen = seen;
  else delete state.usageSeen;
  state.ownerSessionId = session;
  state.usageBaseline = known;
  state.baselinePending = !known;
}

async function pause(cwd, session, reason, nextAction, usage) {
  await updateState(cwd, (state) => {
    if (!state || state.status !== "active") return state;
    if (session && state.ownerSessionId && state.ownerSessionId !== session) return state;
    if (usage) recordUsage(state, usage);
    state.status = "paused";
    state.reason = reason;
    state.nextAction = nextAction;
    state.updatedAt = Date.now();
    return state;
  });
}

async function stop(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  const usage = usageOf(request);
  let state;
  try { state = await readState(cwd); }
  catch { return; }
  if (!state) return;
  if (state.status === "paused" || state.status === "blocked") {
    // The tool may have paused/blocked the goal during this run. Record the run's usage
    // without changing lifecycle metadata; a later SessionStart rebase must not lose it.
    if (session && state.ownerSessionId && state.ownerSessionId !== session) return;
    try {
      await updateState(cwd, (current) => {
        if (!current || (current.status !== "paused" && current.status !== "blocked")) return current;
        if (session && current.ownerSessionId && current.ownerSessionId !== session) return current;
        recordUsage(current, usage);
        current.updatedAt = Date.now();
        return current;
      });
    } catch { /* Accounting is best-effort for an already paused goal. */ }
    return;
  }
  if (state.status !== "active") return;
  if (session && state.ownerSessionId && state.ownerSessionId !== session) {
    message("This goal belongs to another session in the same workspace.");
    return;
  }
  if (request.run?.status !== "completed") {
    await pause(cwd, session, `run_${request.run?.status ?? "stopped"}`, "Resume the goal explicitly.", usage);
    message(`Goal paused: ${request.run?.status ?? "stopped"}.`);
    return;
  }
  let result;
  try {
    result = await updateState(cwd, (current) => {
      if (!current || current.status !== "active") return current;
      if (session && current.ownerSessionId && current.ownerSessionId !== session) return current;
      if (session && !current.ownerSessionId) current.ownerSessionId = session;
      if (!current.usageBaseline || current.baselinePending) {
        current.usageBaseline = zeroUsage();
        current.baselinePending = false;
      }
      const budget = budgetReason(current, usage);
      recordUsage(current, usage);
      if (current.continuations >= current.budget.maxContinuations) {
        current.status = "paused";
        current.reason = "continuation_limit";
        current.nextAction = "Raise maxContinuations or clear the goal.";
        current.updatedAt = Date.now();
        return current;
      }
      if (budget) {
        current.status = "paused";
        current.reason = budget;
        current.nextAction = "Raise the budget or clear the cap, then resume explicitly.";
        current.updatedAt = Date.now();
        return current;
      }
      current.continuations += 1;
      current.updatedAt = Date.now();
      return current;
    });
  } catch { return; }
  if (!result) return;
  if (session && result.ownerSessionId && result.ownerSessionId !== session) {
    message("This goal belongs to another session in the same workspace.");
    return;
  }
  if (result.status !== "active") {
    message(`Goal paused: ${result.reason ?? result.status}.`);
    return;
  }
  output({ decision: "deny", reason: reasonFor(result) });
}

async function sessionStart(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  try {
    const result = await updateState(cwd, (state) => {
      if (!state || (state.status !== "active" && state.status !== "paused" && state.status !== "blocked")) return state;
      const changedOwner = !!session && state.ownerSessionId !== session;
      if (changedOwner) {
        // A new runtime attach owns the workspace goal from here. usageCarried keeps the
        // spending already recorded; the new owner counts from its own watermark.
        handOver(state, session);
      }
      if (state.status === "active") {
        state.status = "paused";
        state.reason = "interrupted";
        state.nextAction = "Resume the goal explicitly.";
        state.updatedAt = Date.now();
      } else if (changedOwner) {
        state.updatedAt = Date.now();
      }
      return state;
    });
    if (result?.status === "paused" && result.reason === "interrupted") {
      message("Goal paused after restart; resume it explicitly.");
    }
  } catch { /* SessionStart is an observation. */ }
}

async function userPrompt(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  // A goal command is a package skill prompt, not an ordinary user message. Let the model see it
  // without first pausing the goal it is asking about.
  if (GOAL_COMMAND.test(inputText(request).trim())) {
    output({ decision: "continue" });
    return;
  }
  let note;
  try {
    const result = await updateState(cwd, (state) => {
      if (!state || state.status !== "active") return state;
      if (session && state.ownerSessionId && state.ownerSessionId !== session) return state;
      if (session && !state.ownerSessionId) state.ownerSessionId = session;
      state.status = "paused";
      state.reason = "user_message";
      state.nextAction = "Run goal resume before continuing.";
      state.updatedAt = Date.now();
      return state;
    });
    if (result?.status === "paused" && result.reason === "user_message") {
      note = "Goal paused for the new user message; resume it explicitly.";
    }
  } catch { /* Never block a user prompt. */ }
  output({ decision: "continue", ...(note ? { message: note } : {}) });
}

async function main(input) {
  let request;
  try { request = JSON.parse(input); }
  catch {
    output({ decision: "continue" });
    return;
  }
  if (!request || typeof request !== "object" || typeof request.event !== "string" || typeof request.cwd !== "string") {
    output({ decision: "continue" });
    return;
  }
  try {
    if (request.event === "Stop") await stop(request);
    else if (request.event === "SessionStart") await sessionStart(request);
    else if (request.event === "UserPromptSubmit") await userPrompt(request);
  } catch {
    if (request.event === "UserPromptSubmit") output({ decision: "continue" });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { void main(input); });
