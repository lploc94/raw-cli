import { tmpdir } from "node:os";
import type { AgentSession } from "./agent.js";
import { normalizeUsage } from "./llm/cache.js";
import { base64ByteLength, type ModelMessage, type ModelRequestOptions, type ProviderAdapter, type ProviderTurn, type UserInput } from "./llm/types.js";
import type { ToolDefinition } from "./tools/registry.js";
import { elideMiddle } from "./tools/results.js";
import { SPILL_PATH_RESERVE, savedLabel, spillText } from "./tools/spill.js";
import type { ToolResult } from "./tools/types.js";

export interface CompactOptions {
  provider?: ProviderAdapter;
  keepRecentTurns?: number;
  maxOutputTokens?: number;
  /** `maxOutputTokens` is a default, not a configured cap; omitting `maxOutputTokens` implies it. */
  maxOutputTokensDefaulted?: boolean;
  /** Extra text appended to the checkpoint prompt (`compact.instructions`). */
  instructions?: string;
}

export interface CompactResult {
  status: "compacted" | "noop" | "not_smaller" | "cancelled";
  beforeBytes?: number;
  afterBytes?: number;
  usage?: unknown;
}

export interface CompactSnapshot {
  messages: readonly ModelMessage[];
  originalTask?: UserInput;
  previousSummary?: string;
}

export interface CompactWorkResult {
  result: CompactResult;
  replacement?: ModelMessage[];
  summary?: string;
}

export const DEFAULT_COMPACT_OUTPUT_TOKENS = 16384;

/**
 * Summary output cap used when none is configured: 16k, bounded by the model's output capability and a quarter of its
 * context, and kept above a manual Anthropic thinking budget so the default never fails validation.
 */
export function defaultCompactOutputTokens(model: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined;
  request?: Readonly<ModelRequestOptions> | undefined }): number {
  let limit = Math.min(DEFAULT_COMPACT_OUTPUT_TOKENS, model.maxOutputTokens ?? Infinity,
    model.contextWindow !== undefined ? Math.max(1, Math.floor(model.contextWindow / 4)) : Infinity);
  const thinking = model.request?.kind === "anthropic" ? model.request.thinking : undefined;
  // A manual budget is already validated below the ordinary request cap, so that cap is a summary limit the API accepts.
  if (thinking?.type === "enabled" && limit <= thinking.budgetTokens) {
    limit = model.request?.maxOutputTokens ?? model.maxOutputTokens ?? thinking.budgetTokens + 1;
  }
  return limit;
}

export const COMPACT_SYSTEM_PROMPT =
  "You summarize a coding agent's conversation into a checkpoint the agent continues from. Follow the instructions at the end of the user message and answer with text only.";

/** Starts the checkpoint prompt when the summarizer sees a rendered transcript instead of its own context (design §7.2). */
export const CHECKPOINT_NO_TOOLS_GUARD = "Respond with text only. Do not call tools; you have everything you need above.";

/** Merge rules placed after `<prior-checkpoint>` when an earlier checkpoint, or the previous chunk's, exists (design §7.2). */
export const CHECKPOINT_MERGE_PREFIX = `<prior-checkpoint> is your checkpoint from an earlier compaction; everything before it is gone. Write one new checkpoint that replaces it:
- Carry forward goals, constraints, user instructions, decisions, rejected approaches and open items from <prior-checkpoint> even when the newer conversation does not mention them. Drop only what is finished and no longer needed to continue.
- The newer conversation wins on conflict: state the corrected fact and drop the old claim.
- Move finished items to [done] with their evidence. Update "Current position" and "Next actions" to the latest state.`;

/** The checkpoint prompt of design §7.2; `{WORDS}` is replaced by `checkpointWords`. */
export const CHECKPOINT_PROMPT = `You are checkpointing your own working memory. The conversation above is about to be deleted from your context. After this, you will continue the same task with only: the system prompt, the user's messages (kept verbatim by the host), the last few steps (kept verbatim), and the checkpoint you write now. Anything you leave out is gone, including your reasoning, which the host never keeps.

Write the checkpoint for yourself, not for the user. The test is: after reading it, you resume mid-step without re-reading files you already understood, without re-running work that is done, and without retrying an approach you already rejected.

Rules:
- Use only facts from the conversation. Mark anything you inferred but did not verify as "(unverified)".
- Keep exact identifiers: file paths with line numbers, function and type names, commands, config keys, commit hashes, test names, error strings, numbers. Quote error messages and the user's own words exactly.
- Say where something can be re-derived cheaply (\`git diff\`, a file path and line range, a saved output file) instead of copying it. Copy only what would be expensive or impossible to recover: conclusions, measurements, reasons, and text that is no longer on disk.
- Be specific about status. "Done" means committed or verified; say which. Separate committed changes from uncommitted edits in the working tree.
- Take each item's status from what the conversation last reported. Never downgrade an item reported done because you judge that its original proposal was not fully met; record such a gap once, marked "(unverified)", under "Knowledge to keep", and do not add work for it to "Plan and status" or "Next actions".
- Do not plan new work the conversation did not decide on. Do not write anything addressed to the user.
- Length: this checkpoint replaces tens of thousands of tokens of history and is the only copy of what you know. Use up to about {WORDS} words. Completeness beats brevity; terse bullets are fine, but do not drop a fact to save space.
- For each done plan item, say what it changed in behavior (old value -> new value, new fields, new messages), not only its name.
- Write in English; quote user words in their original language.
- The host already keeps the user's messages, the last steps, files touched, saved outputs, background processes and the todo list. Refer to them; do not copy them.
- If a fact you need was cut or omitted from your view (a truncated result, an "omitted" marker), say so and name where to re-read it. Never fill the gap with a guess.

Procedure. First, inside <analysis></analysis> (discarded by the host, so keep it to short notes), go through this checklist against the conversation. For each line, write what you found or "none". Do not skip a line.
1. User messages: each request, constraint and preference; which instruction is the latest.
2. Work items: every enumerated item (numbered issues, audit items, todo entries, plan steps). List every ID; never write "etc." or a range you did not check.
3. Status per item ID: done (with commit or evidence) / in progress / not started / dropped.
4. Commits and saves: every commit hash and what it covered; pushed or not.
5. Uncommitted edits: files changed since the last commit.
6. Last verification: the command, pass/fail counts, failing test names, the exact error line.
7. Errors met: exact message -> root cause -> fix, one line each, including small bugs found in your own new code.
8. Behavior changed: old value -> new value for every limit, default, flag, formula or message you changed.
9. Decisions and pushback: what was chosen or argued, and the argument used.
10. Rejected approaches and traps: what not to retry, and misleading signals.
11. Things in flight outside the conversation: background jobs, review or remote sessions, servers, temp files; their IDs or paths and the exact command to resume or check them.
12. How this work is done here: how edits are applied, test and build commands, commit message format and trailers, steps required before commit or handoff.
13. The last 3 actions and their results, and what you were about to do next.

Then, after </analysis>, write the checkpoint. Every non-"none" checklist line must land in some section; nothing found in the checklist may be dropped.

Output exactly these sections, in this order. Keep every heading; write "(none)" when a section is empty.

## Goal
What the user wants and how they will judge it done, in one or two sentences. Then every explicit user constraint, preference, or instruction still in force, quoted where the wording matters.

## Plan and status
The plan being followed, as an ordered list. One line per item: [done <commit or evidence>] / [in progress] / [todo] / [dropped: reason]. Include items the user asked for that are not started yet.

## Current position
Exactly where work stopped: the step in progress, the last command or edit and what it returned, and what you were about to do and why. If you were debugging, state the leading hypothesis, the evidence for it (exact numbers, output lines), and what would confirm or refute it.

## Decisions and reasons
Choices made and why, especially non-obvious ones and choices the user approved. One line each.

## Rejected and failed
Approaches tried or considered and abandoned, with why, so they are not retried. Include dead ends, misleading signals, and traps discovered (for example "X looks broken but is because Y").

## Working tree
Files changed and not yet committed, with a few words on what changed in each. Then recent commits made in this task, hash and subject. Point at \`git diff\` or \`git show\` for detail.

## Verification
What has been checked and the result: tests, builds, typechecks, manual runs. Exact names of anything failing and the exact error line.

## Knowledge to keep
Facts learned about the code, tools, or environment that are needed to finish and are costly to rediscover: how a mechanism works, conventions this repo follows, commands that work, locations of key code (path:line).

## Next actions
The immediate next action, concrete enough to execute without thinking (command, file, edit). Then the following steps in order, up to the end of the plan.`;

/** Conservative token cost of one user image; base64 is never counted as text. */
export const USER_IMAGE_TOKEN_ESTIMATE = 1600;

export function estimateRequestTokens(system: string, messages: readonly ModelMessage[], tools: readonly ToolDefinition[]): number {
  let images = 0;
  const light = messages.map((message): ModelMessage => {
    if (message.role !== "user" || typeof message.content === "string" || !message.content.some((block) => block.type === "image")) return message;
    return { role: "user", content: message.content.map((block) => {
      if (block.type !== "image") return block;
      images++;
      return { type: "image" as const, data: "", mimeType: block.mimeType };
    }) };
  });
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages: light, tools }), "utf8") / 2) + 32 + images * USER_IMAGE_TOKEN_ESTIMATE;
}

/** Thrown when the checkpoint prompt, running checkpoint and output budget leave no room for even one transcript record. */
export class CompactionOverheadError extends Error {
  constructor(message = "compaction prompt and checkpoint leave no room for the conversation in the summarizer context") {
    super(message);
    this.name = "CompactionOverheadError";
  }
}

/** Smallest checkpoint output budget the overhead check lowers to (design §6.3). */
export const MIN_CHECKPOINT_OUTPUT_TOKENS = 1024;
/** Tool results longer than this are head/tail-cut in the summarizer input, naming their saved copy (design §6.3). */
export const TRANSCRIPT_RESULT_BYTES = 4096;
const SHRINK_BYTES = [2048, 1024, 512, 256];
const SUMMARY_PREFIX = "[Conversation summary]\n";

/** The `{WORDS}` length rule: 60% of the output budget, at most the 4,000 words the pilot measured. */
export function checkpointWords(maxOutputTokens: number): number {
  return Math.min(4000, Math.round(0.6 * maxOutputTokens));
}

export function checkpointPrompt(options: { words: number; instructions?: string | undefined; prior?: string | undefined }): string {
  return [
    CHECKPOINT_NO_TOOLS_GUARD,
    ...(options.prior !== undefined ? [`<prior-checkpoint>\n${options.prior}\n</prior-checkpoint>`, CHECKPOINT_MERGE_PREFIX] : []),
    CHECKPOINT_PROMPT.replace("{WORDS}", String(options.words)),
    ...(options.instructions?.trim() ? [`Additional instructions from the agent configuration:\n${options.instructions}`] : []),
  ].join("\n\n");
}

/** The checkpoint the host keeps: the model output without its discarded `<analysis>` notes. */
export function checkpointText(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  // Notes cut off before their closing tag are still notes.
  const open = text.indexOf("<analysis>");
  if (open !== -1) text = text.slice(0, open);
  return text.trim();
}

/** Readable reasoning a provider returned inside `opaque`; signatures, encrypted and unknown data are left out. */
function readableReasoning(opaque: unknown): string[] {
  const found: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) found.push(value); };
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (Array.isArray(opaque)) {
    for (const item of opaque.map(record)) {
      if (!item) continue;
      if (item.type === "thinking") add(item.thinking);
      else if (item.type === "reasoning") {
        for (const part of Array.isArray(item.summary) ? item.summary.map(record) : []) add(part?.text);
        for (const part of Array.isArray(item.content) ? item.content.map(record) : []) if (part?.type === "reasoning_text") add(part.text);
      } else if (item.thought === true) add(item.text);
    }
  } else {
    const fields = record(opaque);
    add(fields?.reasoning_content);
    for (const detail of Array.isArray(fields?.reasoning_details) ? fields.reasoning_details.map(record) : []) {
      if (typeof detail?.text === "string") add(detail.text);
      else add(detail?.summary);
    }
  }
  return found;
}

function userText(input: UserInput): string {
  if (typeof input === "string") return input;
  return input.map((block) => block.type === "text" ? block.text
    : block.type === "image" ? `[Image: ${block.mimeType}, ${base64ByteLength(block.data)} bytes${block.name ? `, ${JSON.stringify(block.name)}` : ""}]`
    : `[Resource link] ${JSON.stringify(block)}`).join("\n");
}

function resultText(result: ToolResult): string {
  return result.content.map((block) => block.type === "text" ? block.text
    : block.type === "json" ? JSON.stringify(block.value)
    : `[Image: path=${block.path ?? "unknown"}; mime=${block.mimeType}; bytes=${block.byteSize ?? base64ByteLength(block.data)}]`).join("\n");
}

export interface RenderOptions {
  /** Tool results above this many bytes are head/tail-cut around a marker naming their saved copy; arguments are cut too. */
  toolResultBytes?: number;
  /** Also cuts user, assistant, reasoning and argument text, for a step that does not fit a chunk whole. */
  textBytes?: number;
  /** Saves a result's rendered text and returns where; the spill store by default. */
  saveCopy?: (text: string) => string | undefined;
  /** Saved copies already made, so re-rendering a result does not save it again. */
  copies?: WeakMap<object, string>;
}

function saveToSpill(text: string): string | undefined {
  const saved = spillText("compaction", text);
  return savedLabel(saved.path, saved.capped);
}

/** Where the complete text of a tool result can be re-read: its saved full output, a saved copy, or `unavailable`. */
function copyPath(message: Extract<ModelMessage, { role: "tool" }>, options: RenderOptions): string {
  if (message.result.fullOutputPath) return savedLabel(message.result.fullOutputPath, message.result.fullOutputCapped)!;
  let path = options.copies?.get(message);
  if (path === undefined) {
    try { path = (options.saveCopy ?? saveToSpill)(resultText(message.result)); } catch { path = undefined; }
    path ??= "unavailable";
    options.copies?.set(message, path);
  }
  return path;
}

/** Labeled lines the summarizer reads instead of provider JSON (design §6.3). */
export function renderTranscript(messages: readonly ModelMessage[], options: RenderOptions = {}): string {
  const limit = options.toolResultBytes ?? TRANSCRIPT_RESULT_BYTES;
  const cut = (text: string) => options.textBytes === undefined ? text : elideMiddle(text, options.textBytes).text;
  return messages.map((message) => {
    if (message.role === "user") return `USER:\n${cut(userText(message.content))}`;
    if (message.role === "assistant") {
      return [
        ...readableReasoning(message.opaque).map((text) => `REASONING:\n${cut(text)}`),
        ...(message.text ? [`ASSISTANT:\n${cut(message.text)}`] : []),
        // Long arguments (a written file's content) are cut like results; what they wrote is on disk.
        ...message.toolCalls.map((call) => `TOOL CALL ${call.name}(${elideMiddle(call.rawArguments ?? JSON.stringify(call.arguments), options.textBytes ?? limit).text})`),
      ].join("\n\n");
    }
    const text = resultText(message.result);
    const status = message.result.isError ? " (error)" : "";
    if (Buffer.byteLength(text) <= limit) return `TOOL RESULT ${message.name}${status}:\n${text}`;
    return `TOOL RESULT ${message.name}${status}:\n${elideMiddle(text, limit, copyPath(message, options)).text}`;
  }).filter(Boolean).join("\n\n");
}

/**
 * The last-resort form of a step: what was called and how large the results were, with where each result can be
 * re-read. `path` saves copies as needed; a sizing pass passes a placeholder at least as long as any saved path.
 */
function oneLineRecord(step: readonly ModelMessage[], path: (message: Extract<ModelMessage, { role: "tool" }>) => string): string {
  const parts = step.map((message) => {
    if (message.role === "user") {
      const text = userText(message.content);
      return `USER message of ${Buffer.byteLength(text)} bytes: ${elideMiddle(text, 160).text.replace(/\s+/g, " ")}`;
    }
    if (message.role === "assistant") {
      return `ASSISTANT ${Buffer.byteLength(message.text)} bytes of text${message.toolCalls.map((call) =>
        `; TOOL CALL ${call.name}(${elideMiddle(call.rawArguments ?? JSON.stringify(call.arguments), 80).text.replace(/\s+/g, " ")})`).join("")}`;
    }
    return `TOOL RESULT ${message.name}: ${Buffer.byteLength(resultText(message.result))} bytes, full output: ${path(message)}`;
  });
  return `[Step shortened to fit the summarizer: ${parts.join("; ")}]`;
}

/** Records of the summarizer input: a user message alone, or an assistant message with all of its tool results. */
function transcriptSteps(messages: readonly ModelMessage[]): ModelMessage[][] {
  const steps: ModelMessage[][] = [];
  for (const message of messages) {
    const last = steps.at(-1);
    if (message.role === "tool" && last && last[0]!.role === "assistant") last.push(message);
    else steps.push([message]);
  }
  return steps;
}

/** JSON-escaped byte length of `text`, which is additive across concatenation. */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function completeTurns(messages: readonly ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push([message]);
    else {
      const current = turns.at(-1);
      if (!current) throw new Error("transcript has content before the first user message");
      current.push(message);
    }
  }
  return turns;
}

function byteLength(messages: readonly ModelMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export async function performCompaction(
  snapshot: CompactSnapshot,
  provider: ProviderAdapter,
  options: Required<Pick<CompactOptions, "keepRecentTurns" | "maxOutputTokens">> & {
    timeoutMs: number; signal: AbortSignal; cacheKey: string; maxOutputTokensDefaulted?: boolean; instructions?: string | undefined;
    saveCopy?: (text: string) => string | undefined;
    onRequestStart?: (index: number) => void; onUsage?: (index: number, raw: unknown) => void;
  },
): Promise<CompactWorkResult> {
  const beforeBytes = byteLength(snapshot.messages);
  const history = snapshot.previousSummary ? snapshot.messages.slice(1) : snapshot.messages;
  const turns = completeTurns(history);
  if (snapshot.previousSummary && turns[0]?.length === 1 && turns.length <= options.keepRecentTurns + 1) {
    return { result: { status: "noop", beforeBytes, afterBytes: beforeBytes } };
  }
  const older = turns.slice(0, Math.max(0, turns.length - options.keepRecentTurns));
  if (!older.length) return { result: { status: "noop", beforeBytes, afterBytes: beforeBytes } };
  const retained = turns.slice(turns.length - options.keepRecentTurns).flat();
  // The previous summary message, which follows the pinned original task, is merged as <prior-checkpoint> rather than
  // summarized again; a user message that merely starts with the same words stays conversation.
  const prior = snapshot.previousSummary ? snapshot.messages[snapshot.originalTask !== undefined ? 1 : 0] : undefined;
  const summarized = older.flat().filter((message) => !(message === prior && message.role === "user"
    && typeof message.content === "string" && message.content.startsWith(SUMMARY_PREFIX)));
  const steps = transcriptSteps([
    ...(snapshot.previousSummary && snapshot.originalTask !== undefined ? [{ role: "user" as const, content: snapshot.originalTask }] : []),
    ...summarized,
  ]);
  const render: RenderOptions = { copies: new WeakMap(), ...(options.saveCopy ? { saveCopy: options.saveCopy } : {}) };
  const rendered = steps.map((step) => renderTranscript(step, render));
  const context = provider.modelConfig.contextWindow;
  const margin = context === undefined ? 0 : Math.max(64, Math.ceil(context * 0.05));
  const content = (transcript: string, prompt: string) => `${transcript}\n\n${prompt}`;
  const fits = (input: string, outputTokens: number) => context === undefined
    || estimateRequestTokens(COMPACT_SYSTEM_PROMPT, [{ role: "user", content: input }], []) + outputTokens + margin <= context;
  // A lowered budget must stay above a manual Anthropic thinking budget, or the request is invalid.
  const thinking = provider.modelConfig.request?.kind === "anthropic" ? provider.modelConfig.request.thinking : undefined;
  const thinkingFloor = thinking?.type === "enabled" ? thinking.budgetTokens + 1 : 0;
  // Sizes a one-line record before its copies are saved: no saved path is longer than this.
  // Counted in JSON bytes, the estimator's unit, so a non-ASCII temp directory is not undercounted.
  const placeholderPath = "x".repeat(jsonBytes(tmpdir()) + SPILL_PATH_RESERVE - tmpdir().length + 64);
  let summary = snapshot.previousSummary;
  let usage: unknown;
  for (let offset = 0, requestIndex = 0; offset < steps.length;) {
    const prompt = (budget: number) => checkpointPrompt({ words: checkpointWords(budget), instructions: options.instructions, prior: summary });
    // Overhead first: the prompt, running checkpoint, output budget and margin must leave room for one one-line record.
    let budget = options.maxOutputTokens;
    let minimal = oneLineRecord(steps[offset]!, (message) => message.result.fullOutputPath
      ? savedLabel(message.result.fullOutputPath, message.result.fullOutputCapped)! : placeholderPath);
    // Placeholders overstate a record of many results; its real form is measured before the budget is lowered.
    if (!fits(content(minimal, prompt(budget)), budget)) minimal = oneLineRecord(steps[offset]!, (message) => copyPath(message, render));
    if (!fits(content(minimal, prompt(budget)), budget)) {
      const floor = Math.min(options.maxOutputTokens, Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, thinkingFloor));
      const fixed = estimateRequestTokens(COMPACT_SYSTEM_PROMPT, [{ role: "user", content: content(minimal, prompt(floor)) }], []);
      // A few tokens of slack cover the longer `{WORDS}` number of the larger budget.
      budget = Math.min(budget, context! - margin - fixed - 8);
      if (budget < floor || !fits(content(minimal, prompt(budget)), budget)) throw new CompactionOverheadError();
    }
    const instruction = prompt(budget);
    // Admission is counted incrementally: the request estimate is a JSON byte count, which is additive over the parts.
    const fixedBytes = Buffer.byteLength(JSON.stringify({ system: COMPACT_SYSTEM_PROMPT, messages: [{ role: "user", content: "" }], tools: [] }), "utf8")
      + jsonBytes(`\n\n${instruction}`);
    const room = context === undefined ? Infinity : (context - margin - budget - 32) * 2;
    const parts: string[] = [];
    let used = fixedBytes;
    let end = offset;
    while (end < steps.length) {
      const added = jsonBytes(rendered[end]!) + (parts.length ? jsonBytes("\n\n") : 0);
      if (used + added > room) break;
      parts.push(rendered[end]!);
      used += added;
      end++;
    }
    if (end === offset) {
      // A step too large for a chunk of its own is cut to fit, and becomes a one-line record when even that does not fit.
      const shortened = SHRINK_BYTES.map((bytes) => renderTranscript(steps[offset]!, { ...render, toolResultBytes: bytes, textBytes: bytes }))
        .find((text) => fits(content(text, instruction), budget));
      const record = shortened ?? oneLineRecord(steps[offset]!, (message) => copyPath(message, render));
      // The record now names the real saved copies; one longer than the sizing allowed cannot be sent.
      if (!fits(content(record, instruction), budget)) throw new CompactionOverheadError();
      parts.push(record);
      end++;
    }
    const input = content(parts.join("\n\n"), instruction);
    let turn: ProviderTurn;
    for (;;) {
      const index = requestIndex++;
      options.onRequestStart?.(index);
      turn = await provider.generate({
        system: COMPACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: input }],
        tools: [],
        timeoutMs: options.timeoutMs,
        maxOutputTokens: budget,
        // The default summary cap, a lowered or doubled budget, is Raw's guess; the model's stated maximum may lower it.
        ...(budget !== options.maxOutputTokens || options.maxOutputTokensDefaulted ? { maxOutputTokensAssumed: true } : {}),
        signal: options.signal,
        cacheKey: options.cacheKey,
        onUsage: (raw) => { if (!options.signal.aborted) options.onUsage?.(index, raw); },
      });
      if (!options.signal.aborted && turn.usage !== undefined) options.onUsage?.(index, turn.usage);
      if (options.signal.aborted) return { result: { status: "cancelled", beforeBytes, afterBytes: beforeBytes } };
      // A summary cut at the output limit is retried once with twice the budget when the model and context allow it.
      const larger = Math.min(budget * 2, provider.modelConfig.maxOutputTokens ?? Infinity);
      if (!turn.truncated || budget !== options.maxOutputTokens || larger <= budget || !fits(input, larger)) break;
      budget = larger;
    }
    if (turn.toolCalls.length || (!turn.truncated && !["stop", "end_turn", "STOP"].includes(turn.finishReason))) throw new Error("compaction did not return a final text answer");
    const checkpoint = checkpointText(turn.text);
    if (!checkpoint) throw new Error("compaction returned an empty summary");
    const reportedOutput = normalizeUsage(provider.modelConfig.method, turn.usage, provider.modelConfig.provider).outputTokens;
    if (reportedOutput !== undefined && reportedOutput > budget) throw new Error("compaction exceeded output token budget");
    // Still cut after the retry: a lossy summary that says so beats keeping a transcript too large to continue.
    summary = turn.truncated ? `${checkpoint}\n[Summary cut off at the output token limit.]` : checkpoint;
    usage = turn.usage;
    offset = end;
  }
  const replacement: ModelMessage[] = [
    ...(snapshot.originalTask !== undefined ? [{ role: "user" as const, content: snapshot.originalTask }] : []),
    { role: "user", content: `${SUMMARY_PREFIX}${summary}` },
    ...retained,
  ];
  const afterBytes = byteLength(replacement);
  if (afterBytes >= beforeBytes) return { result: { status: "not_smaller", beforeBytes, afterBytes, ...(usage !== undefined ? { usage } : {}) } };
  return {
    result: { status: "compacted", beforeBytes, afterBytes, ...(usage !== undefined ? { usage } : {}) },
    replacement, summary: summary!,
  };
}

export function compactSession(session: AgentSession, options: CompactOptions = {}): Promise<CompactResult> {
  return session.compact(options);
}
