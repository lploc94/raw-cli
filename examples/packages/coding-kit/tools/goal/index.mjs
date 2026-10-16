/**
 * The coding kit's `goal` tool: one panel holding what the user wants, how they will judge it done, and the criteria
 * and steps that track it. The state lives in the panel document, so it survives restarts and compaction and needs no
 * file I/O and no side effects (docs/panels-design.md §18 for `builtin/todo`, §19 for a third-party panel tool).
 *
 * This file is self-contained on purpose: a package tool runs from the installed artifact under the recipient's data
 * directory, where Raw's own source modules are not importable. The numbers below mirror the host's limits
 * (`PANEL_LIMITS` in src/panels/contract.ts) so a published document is never rejected by `validateDocument`.
 */

const MAX_CRITERIA = 50;
const MAX_STEPS = 30;
/** The panel document's own limits (src/panels/validate.ts): title 80, subtitle 120, whole document 64 KiB. */
const GOAL_CHARS = 80;
const DONE_WHEN_CHARS = 120;
const MAX_DOCUMENT_BYTES = 65536;
/** The host's default timeline bound: at most 100 events in one timeline block (src/panels/validate.ts). */
const MAX_EVENTS = 100;
const CONTEXT_SUMMARY_BYTES = 2048;

const STATUSES = new Set(["pending", "in_progress", "done", "blocked", "skipped"]);
const FINISHED = new Set(["done", "skipped"]);
const CRITERIA = "criteria";
const STEPS = "steps";
const LOG = "log";
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const failure = (code, message) => ({ isError: true, code, content: [{ type: "text", text: message }] });
/** Panel text rejects control characters; model-authored labels are cleaned rather than failing the whole call. */
const clean = (value) => String(value).replace(CONTROL, " ").trim();
const glyph = (status) => status === "done" ? "[x]" : status === "in_progress" ? "[~]" : status === "blocked" ? "[!]"
  : status === "skipped" ? "[-]" : "[ ]";
const line = (item) => `${glyph(item.status)} ${item.id} ${item.label}${item.note ? ` — ${item.note}` : ""}`;

/** Cut to whole characters, for the `title`/`subtitle` limits the panel validator counts in characters. */
function clip(value, limit) {
  const scalars = [...value];
  return scalars.length <= limit ? value : `${scalars.slice(0, limit - 1).join("")}…`;
}

/** Cut to whole UTF-8 characters within a byte limit; the ellipsis is counted. */
function clipBytes(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let text = "", used = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (used + size > limit - 3) break;
    text += scalar; used += size;
  }
  return `${text}…`;
}

/** Argument-only validation (docs/panels-design.md §18): it never sees panel state. */
export function validateArgs(args) {
  const value = args ?? {};
  const mode = value.mode ?? "set";
  if (mode !== "set" && mode !== "update") return `mode must be "set" or "update", not "${String(mode)}"`;
  if (mode === "set") {
    if (typeof value.goal !== "string" || !clean(value.goal)) return "mode set needs goal: what the user wants";
    if (typeof value.done_when !== "string" || !clean(value.done_when)) {
      return "mode set needs done_when: how the user will judge the goal done";
    }
    if (value.clear !== undefined) return "clear is only allowed in update mode";
  } else {
    if (value.goal !== undefined && (typeof value.goal !== "string" || !clean(value.goal))) {
      return "goal must be a non-empty string";
    }
    if (value.done_when !== undefined && (typeof value.done_when !== "string" || !clean(value.done_when))) {
      return "done_when must be a non-empty string";
    }
    if (value.clear !== undefined && value.clear !== "done") return 'clear must be "done"';
  }
  if (value.outcome !== undefined && value.outcome !== "achieved" && value.outcome !== "abandoned") {
    return 'outcome must be "achieved" or "abandoned"';
  }
  // The panel shows the goal as its header and `done_when` as its subtitle, so these are hard limits rather than
  // values this tool silently cuts.
  if (value.goal !== undefined && [...value.goal].length > GOAL_CHARS) {
    return `goal must be at most ${GOAL_CHARS} characters: it is the panel header`;
  }
  if (value.done_when !== undefined && [...value.done_when].length > DONE_WHEN_CHARS) {
    return `done_when must be at most ${DONE_WHEN_CHARS} characters: it is the panel subtitle`;
  }
  const ids = new Set();
  for (const [name, items] of [["criteria", value.criteria], ["steps", value.steps]]) {
    if (items === undefined) continue;
    if (!Array.isArray(items)) return `${name} must be an array`;
    for (const [index, raw] of items.entries()) {
      const at = `${name}[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} must be an object`;
      if (raw.id !== undefined) {
        if (typeof raw.id !== "string" || !ITEM_ID.test(raw.id)) return `${at}: id must match ${ITEM_ID.source}`;
        if (ids.has(raw.id)) return `${at}: duplicate id "${raw.id}"`;
        ids.add(raw.id);
      }
      // In set mode every item is new, so it needs its text. In update mode a change is either keyed by an id or, with
      // no id, a new item that carries its own label. Cleaning happens before this check, so text that is only control
      // characters cannot become a label the panel must reject later.
      const needsLabel = mode === "set" || raw.id === undefined;
      if (needsLabel && (typeof raw.label !== "string" || !clean(raw.label))) {
        return mode === "set" ? `${at}: label is required` : `${at}: a new item needs a label`;
      }
      if (raw.label !== undefined && (typeof raw.label !== "string" || !clean(raw.label))) {
        return `${at}: label must be a non-empty string`;
      }
      if (raw.status !== undefined && !STATUSES.has(raw.status)) return `${at}: unknown status "${String(raw.status)}"`;
    }
  }
  return undefined;
}

/**
 * Gives every item an id, preferring the smallest unused `<prefix><n>`. `used` is shared by the criteria and the steps
 * of one call, so an id one list already uses is never handed out again in the other: the host validates each block
 * separately, but the tool keeps ids unambiguous across both so one update can name an id from each list.
 */
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

function toItem(raw, kind) {
  const item = { id: raw.id, label: clean(raw.label), status: raw.status ?? "pending" };
  if (raw.note !== undefined && clean(raw.note)) item.note = clean(raw.note);
  if (kind === "steps" && raw.detail !== undefined && clean(raw.detail)) item.detail = clean(raw.detail);
  return item;
}

/** At most one step may be in progress. Set and update share the invariant. */
function oneStepInProgress(steps) {
  const running = steps.filter((item) => item.status === "in_progress");
  return running.length > 1 ? `item "${running[1].id}": at most one step may be in_progress` : undefined;
}

/**
 * Closes the goal with one timeline event; both modes honour a supplied outcome. The host keeps at most 100 events in
 * a timeline block (`src/panels/validate.ts`), so the outcome the goal already has changes nothing, and a real
 * transition that would overflow the log is refused by name instead of publishing a document the host drops.
 */
function applyOutcome(state, outcome) {
  if (outcome !== "achieved" && outcome !== "abandoned") return state;
  const achieved = outcome === "achieved";
  const status = achieved ? "done" : "failed";
  if (state.status === status) return state;
  if (state.events.length >= MAX_EVENTS) {
    return `the goal already holds ${state.events.length} log events, and one panel keeps at most ${MAX_EVENTS}: ` +
      "it cannot record another outcome";
  }
  state.status = status;
  state.events.push({ id: `e${state.events.length + 1}`, at: Date.now(), level: achieved ? "success" : "warning",
    label: achieved ? "Goal achieved" : "Goal abandoned" });
  return state;
}

function setState(value) {
  const criteria = value.criteria ?? [];
  const steps = value.steps ?? [];
  if (criteria.length > MAX_CRITERIA) {
    return `the goal would hold ${criteria.length} criteria; the limit is ${MAX_CRITERIA}`;
  }
  if (steps.length > MAX_STEPS) return `the goal would hold ${steps.length} steps; the limit is ${MAX_STEPS}`;
  const used = new Set([...criteria, ...steps].flatMap((item) => item.id === undefined ? [] : [item.id]));
  const state = {
    goal: clean(value.goal), done_when: clean(value.done_when), status: "active",
    criteria: idsFor(criteria, "c", used).map((item) => toItem(item, "criteria")),
    steps: idsFor(steps, "s", used).map((item) => toItem(item, "steps")),
    events: [],
  };
  const problem = oneStepInProgress(state.steps);
  if (problem) return problem;
  return applyOutcome(state, value.outcome);
}

function mergeItems(current, changes, kind, prefix, used) {
  const items = current.map((item) => ({ ...item }));
  for (const change of changes ?? []) {
    // A change without an id is a new item; `idsFor` gives it the smallest unused id below.
    if (change.id === undefined) { items.push(toItem(change, kind)); continue; }
    const index = items.findIndex((item) => item.id === change.id);
    if (index < 0) return `unknown ${kind} id "${change.id}"`;
    const target = items[index];
    if (change.label !== undefined) target.label = clean(change.label);
    if (change.status !== undefined) target.status = change.status;
    if (change.note !== undefined) { if (clean(change.note)) target.note = clean(change.note); else delete target.note; }
    if (change.detail !== undefined) { if (clean(change.detail)) target.detail = clean(change.detail); else delete target.detail; }
  }
  return idsFor(items, prefix, used).map((item) => toItem(item, kind));
}

function updateState(before, value) {
  if (!before.goal) return "there is no goal yet; call this tool with mode set first";
  // One id space for both lists: existing ids and the ids this call already names are never handed out again.
  const used = new Set([...before.criteria, ...before.steps].flatMap((item) => [item.id]));
  for (const change of [...(value.criteria ?? []), ...(value.steps ?? [])]) {
    if (change.id !== undefined) used.add(change.id);
  }
  let criteria = mergeItems(before.criteria, value.criteria, "criteria", "c", used);
  if (typeof criteria === "string") return criteria;
  let steps = mergeItems(before.steps, value.steps, "steps", "s", used);
  if (typeof steps === "string") return steps;
  if (value.clear === "done") criteria = criteria.filter((item) => !FINISHED.has(item.status));
  if (criteria.length > MAX_CRITERIA) return `the goal would hold ${criteria.length} criteria; the limit is ${MAX_CRITERIA}`;
  if (steps.length > MAX_STEPS) return `the goal would hold ${steps.length} steps; the limit is ${MAX_STEPS}`;
  const problem = oneStepInProgress(steps);
  if (problem) return problem;
  return applyOutcome({
    goal: value.goal === undefined ? before.goal : clean(value.goal),
    done_when: value.done_when === undefined ? before.done_when : clean(value.done_when),
    status: before.status, criteria, steps, events: before.events.map((event) => ({ ...event })),
  }, value.outcome);
}

function fromDocument(document) {
  const find = (id) => document?.blocks?.find((block) => block.id === id);
  const items = (id) => (find(id)?.items ?? []).map((item) => ({ ...item, status: item.status ?? "pending" }));
  return { goal: document?.title === undefined ? "" : clip(document.title, GOAL_CHARS),
    done_when: document?.subtitle === undefined ? "" : clip(document.subtitle, DONE_WHEN_CHARS),
    status: document?.status ?? "active", criteria: items(CRITERIA), steps: items(STEPS),
    events: find(LOG)?.events ?? [] };
}

const statusWord = (status) => status === "done" ? "achieved" : status === "failed" ? "abandoned" : "active";

function document(state) {
  const met = state.criteria.filter((item) => FINISHED.has(item.status)).length;
  const blocks = [{ id: CRITERIA, kind: "checklist", title: "Acceptance criteria",
    items: state.criteria.map(({ id, label, status, note }) => ({ id, label, status, ...(note ? { note } : {}) })) }];
  if (state.steps.length) {
    blocks.push({ id: STEPS, kind: "steps", title: "Steps",
      items: state.steps.map(({ id, label, status, detail }) => ({ id, label, status, ...(detail ? { detail } : {}) })) });
  }
  if (state.events.length) blocks.push({ id: LOG, kind: "timeline", title: "Log", events: state.events });
  const open = state.criteria.filter((item) => !FINISHED.has(item.status));
  return {
    title: clip(state.goal, GOAL_CHARS),
    subtitle: clip(state.done_when, DONE_WHEN_CHARS),
    status: state.status,
    progress: { done: met, total: state.criteria.length },
    blocks,
    // This is what Raw reminds the model of after a successful compaction (docs/context.md). The status comes first so
    // an abandoned or achieved goal is never presented as ongoing work.
    context_summary: clipBytes([
      `Goal (${statusWord(state.status)}): ${state.goal}`,
      `Done when: ${state.done_when}`,
      `Criteria: ${met}/${state.criteria.length} met${open.length ? `; open: ${open.map((item) => item.label).join("; ")}` : ""}`,
      ...state.steps.length ? [`Steps: ${state.steps.map((item) => `${glyph(item.status)} ${item.label}`).join(" | ")}`] : [],
    ].join("\n"), CONTEXT_SUMMARY_BYTES),
  };
}

export async function handler(args, context) {
  if (!context.panels) return failure("panels_unavailable", "this host does not provide panels");
  const value = args ?? {};
  const state = (value.mode ?? "set") === "set"
    ? setState(value)
    : updateState(fromDocument(context.panels.get("goal")?.document), value);
  if (typeof state === "string") return failure("invalid_goal", state);
  const panel = document(state);
  // The host rejects a document over PANEL_LIMITS.documentBytes; refuse here instead, so an accepted call is never
  // reported as success while nothing is stored.
  const bytes = Buffer.byteLength(JSON.stringify(panel), "utf8");
  if (bytes > MAX_DOCUMENT_BYTES) {
    return failure("invalid_goal",
      `the goal does not fit one panel document: ${bytes} bytes, and the limit is ${MAX_DOCUMENT_BYTES} (64 KiB)`);
  }
  const met = state.criteria.filter((item) => FINISHED.has(item.status)).length;
  const header = `Goal (${statusWord(state.status)}): ${state.goal}`;
  const text = [header, `Done when: ${state.done_when}`,
    `Criteria (${met}/${state.criteria.length} met):`, ...state.criteria.map(line),
    ...state.steps.length ? ["Steps:", ...state.steps.map(line)] : []].join("\n");
  return { isError: false, content: [{ type: "text", text }, { type: "panel", panel: "goal", op: "replace", document: panel }] };
}
