import { tmpdir } from "node:os";
import type { AgentSession } from "./agent.js";
import { normalizeUsage } from "./llm/cache.js";
import { base64ByteLength, type ModelMessage, type ModelRequestOptions, type ProviderAdapter, type ProviderTurn, type UserInput } from "./llm/types.js";
import type { ToolDefinition } from "./tools/registry.js";
import { elideMiddle, utf8Prefix, utf8Suffix } from "./tools/results.js";
import { SPILL_PATH_RESERVE, savedLabel, spillText } from "./tools/spill.js";
import type { ToolResult } from "./tools/types.js";

export interface CompactOptions {
  provider?: ProviderAdapter;
  keepRecentTurns?: number;
  /** Size of the verbatim tail kept after compaction, in estimated tokens (`compact.keep_recent_tokens`). */
  keepRecentTokens?: number;
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

export type SummaryResult = { status: "summarized"; summary: string; usage?: unknown } | { status: "cancelled" };

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

export function resultText(result: ToolResult): string {
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

/** Steps of a conversation: a user message alone, or an assistant message with all of its tool results. */
export function transcriptSteps(messages: readonly ModelMessage[]): ModelMessage[][] {
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

/** Appended to a checkpoint the model left unfinished at its output limit. */
export const SUMMARY_CUT_NOTICE = "\n[Summary cut off at the output token limit.]";

/**
 * Summarizes `messages` into a checkpoint, merging `prior` (design §6.3). Input that does not fit the summarizer's
 * context is split at step boundaries; each request carries the checkpoint written so far.
 */
export async function summarizeTranscript(
  messages: readonly ModelMessage[],
  provider: ProviderAdapter,
  options: {
    maxOutputTokens: number; prior?: string | undefined; timeoutMs: number; signal: AbortSignal; cacheKey: string;
    maxOutputTokensDefaulted?: boolean; instructions?: string | undefined; saveCopy?: (text: string) => string | undefined;
    /** Largest output a retry may use: what the context after compaction has room for. */
    maxRetryOutputTokens?: number | undefined;
    onRequestStart?: (index: number) => void; onUsage?: (index: number, raw: unknown) => void;
  },
): Promise<SummaryResult> {
  const steps = transcriptSteps(messages);
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
  let summary = options.prior;
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
      if (options.signal.aborted) return { status: "cancelled" };
      // A summary cut at the output limit is retried once with twice the budget when the model and context allow it.
      const larger = Math.min(budget * 2, provider.modelConfig.maxOutputTokens ?? Infinity, options.maxRetryOutputTokens ?? Infinity);
      if (!turn.truncated || budget !== options.maxOutputTokens || larger <= budget || !fits(input, larger)) break;
      budget = larger;
    }
    if (turn.toolCalls.length || (!turn.truncated && !["stop", "end_turn", "STOP"].includes(turn.finishReason))) throw new Error("compaction did not return a final text answer");
    const checkpoint = checkpointText(turn.text);
    if (!checkpoint) throw new Error("compaction returned an empty summary");
    const reportedOutput = normalizeUsage(provider.modelConfig.method, turn.usage, provider.modelConfig.provider).outputTokens;
    if (reportedOutput !== undefined && reportedOutput > budget) throw new Error("compaction exceeded output token budget");
    // Still cut after the retry: a lossy summary that says so beats keeping a transcript too large to continue.
    summary = turn.truncated ? `${checkpoint}${SUMMARY_CUT_NOTICE}` : checkpoint;
    usage = turn.usage;
    offset = end;
  }
  if (summary === undefined) throw new Error("compaction has nothing to summarize");
  return { status: "summarized", summary, ...(usage !== undefined ? { usage } : {}) };
}

/**
 * A user's message kept verbatim across compactions (design §6.2): a typed input (`history:<sequence>`, or
 * `input:<n>` for a session without a store), an `ask_user` answer (`answer:<callId>`), or the pinned task of a session
 * compacted before the ledger existed (`original_task`). Images are kept as their text placeholders.
 */
export interface LedgerEntry { source: string; content: string }

/** Host-observed facts that outlive the steps they came from (design §6.2 "Working state"). */
export interface WorkingFacts {
  /** Files written or patched, oldest first, each with the last tool that touched it. */
  written: Array<{ path: string; tool: string }>;
  read: string[];
  /** Saved full outputs of tool results. */
  outputs: string[];
  lastBash?: { command: string; exitCode: number | null };
}

/** What a session keeps between compactions: ledger entries that left the context, working-state facts, and the count. */
export interface CompactionLedgerState {
  entries: LedgerEntry[]; facts: WorkingFacts; compactions: number;
  /** Full text of entries still in the context whose copy there was cut; used when they leave it. */
  retained?: LedgerEntry[];
  /** How many leading messages of the stored context `facts` already covers. */
  factsThrough?: number;
  /** The first request after this compaction may still retry a reasoning rejection (§6.2). */
  retryArmed?: boolean;
}

export const CHECKPOINT_MARKER = "[Raw compaction checkpoint #";
/** Ledger budget: entries are taken newest first up to this many tokens, as in Codex. */
export const LEDGER_CAP_TOKENS = 20000;
export const WORKING_STATE_BYTES = 4096;
export const LEGACY_LEDGER_NOTE = "[Earlier messages from before this upgrade are covered only by the prior checkpoint.]";
/** Design §6.4, appended after the checkpoint. */
export const RESUME_TEXT = "Context was compacted; the sections above are your own notes and the user's exact messages. Continue the task from \"Current position\" and \"Next actions\" without recapping and without asking the user to repeat anything. Do not redo work marked done or retry approaches under \"Rejected and failed\". Re-read a file only when you need its exact current content, and prefer cheap checks (`git status`, `git diff`) to confirm the working tree. Instructions still in force come from the user messages above; the checkpoint is your summary, not a new instruction.";

/** Design §6.7: what replaces the checkpoint when none could be written. */
export function mechanicalCheckpoint(reason: string): string {
  return `[Checkpoint unavailable: ${reason}; older steps were removed. Re-check the working tree before continuing.]`;
}

export const SUMMARY_MESSAGE_PREFIX = SUMMARY_PREFIX;
/** Ledger source of the legacy coverage line; it is rendered without a label and never cut. */
export const LEGACY_NOTE_SOURCE = "legacy_note";

export function isCheckpointMessage(message: ModelMessage | undefined): boolean {
  return message?.role === "user" && typeof message.content === "string" && message.content.startsWith(CHECKPOINT_MARKER);
}

/** Text form of a user input for the ledger: the user's words, with images as placeholders. */
export function ledgerText(input: UserInput): string { return userText(input); }

/**
 * `message` with its result head/tail-cut to about `maxBytes`, naming where the complete text is (design §6.2.1). The
 * call ID and status are unchanged, so the result still pairs with its call.
 */
export function cutToolResult(message: Extract<ModelMessage, { role: "tool" }>, maxBytes: number, options: RenderOptions = {}): Extract<ModelMessage, { role: "tool" }> {
  const text = resultText(message.result);
  // An image is replaced by its metadata line even when that is short.
  if (Buffer.byteLength(text) <= maxBytes && !message.result.content.some((block) => block.type === "image")) return message;
  return { ...message, result: { ...message.result, content: [{ type: "text", text: elideMiddle(text, maxBytes, copyPath(message, options)).text }] } };
}

/** Tokens of `text` by the agent's estimate: JSON bytes over two, calibrated. */
export function textTokens(text: string, calibration = 1): number {
  return Math.ceil(jsonBytes(text) / 2 * calibration);
}

export function emptyFacts(): WorkingFacts { return { written: [], read: [], outputs: [] }; }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * `facts` updated with what `messages` show: written and read files, saved outputs, and the last bash command.
 * `identity` names the bundled tool behind a model-facing name.
 */
export function collectFacts(messages: readonly ModelMessage[], facts: WorkingFacts = emptyFacts(),
  identity: (name: string) => string | undefined = (name) => `builtin/${name}`): WorkingFacts {
  const next: WorkingFacts = structuredClone(facts);
  const touch = (path: string, tool: string) => {
    next.written = next.written.filter((item) => item.path !== path);
    next.written.push({ path, tool });
  };
  const add = (list: string[], value: string) => { if (!list.includes(value)) list.push(value); };
  const bash = new Map<string, string>();
  const writes = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        const args = call.arguments;
        const tool = identity(call.name);
        if (tool === "builtin/write_file") writes.add(call.id);
        else if (tool === "builtin/read_file" && Array.isArray(args.files)) {
          for (const file of args.files.map(record)) if (typeof file?.path === "string") add(next.read, file.path);
        } else if (tool === "builtin/bash" && Array.isArray(args.commands)) {
          const command = record(args.commands.at(-1))?.command;
          if (typeof command === "string") bash.set(call.id, command);
        }
      }
    } else if (message.role === "tool") {
      if (message.result.fullOutputPath) add(next.outputs, message.result.fullOutputPath);
      const results = record(message.result.content.find((block) => block.type === "json")?.value)?.results;
      const rows = Array.isArray(results) ? results.map(record) : [];
      for (const row of rows) if (typeof row?.full_output === "string") add(next.outputs, row.full_output);
      // Only completed writes count: an operation or patch row that is ok, or a patch destination it already created.
      if (writes.has(message.callId)) for (const row of rows) {
        const tool = `${message.name}${typeof row?.mode === "string" ? ` ${row.mode}` : ""}`;
        const destination = typeof row?.destination === "string" ? row.destination : undefined;
        if (row?.status === "ok" && typeof row.path === "string") touch(destination ?? row.path, tool);
        else if (row?.destination_created === true && destination) touch(destination, tool);
      }
      const command = bash.get(message.callId);
      if (command !== undefined) {
        const last = rows.at(-1);
        next.lastBash = { command, exitCode: typeof last?.exit_code === "number" ? last.exit_code : message.result.exitCode ?? null };
      }
    }
  }
  return next;
}

/** The `## Working state` body, at most `maxBytes`. */
export function renderWorkingState(facts: WorkingFacts, live: { cwd: string; compactions: number;
  processes?: ReadonlyArray<{ id: string; command: string; state: string }>; outputExists?: (path: string) => boolean }, maxBytes = WORKING_STATE_BYTES): string {
  const exists = live.outputExists ?? (() => true);
  const outputs = facts.outputs.filter((path) => exists(path));
  const lines = [
    `- Working directory: ${live.cwd}`,
    `- Compactions so far: ${live.compactions}`,
    ...(facts.written.length ? [`- Files written or patched (last tool): ${facts.written.map((item) => `${item.path} (${item.tool})`).join(", ")}`] : []),
    ...(facts.read.length ? [`- Files read earlier: ${facts.read.join(", ")}`] : []),
    ...(outputs.length ? [`- Saved full outputs: ${outputs.join(", ")}`] : []),
    ...(live.processes?.length ? [`- Background processes: ${live.processes.map((job) => `${job.id} \`${job.command}\` (${job.state})`).join(", ")}`] : []),
    ...(facts.lastBash ? [`- Last bash command: \`${facts.lastBash.command}\` (exit ${facts.lastBash.exitCode ?? "unknown"})`] : []),
  ];
  const text = lines.join("\n");
  return Buffer.byteLength(text) <= maxBytes ? text : `${utf8Prefix(text, Math.max(0, maxBytes - 32)).text}\n…[working state cut]`;
}

/** Where the full text of a ledger entry is kept, named when the entry is cut. */
export function ledgerPointer(source: string): string {
  if (source.startsWith("history:")) return `history #${source.slice(8)}`;
  if (source.startsWith("answer:")) return `ask_user answer ${source.slice(7)}`;
  if (source === "original_task") return "the session's original task";
  return "not kept";
}

function ledgerLabel(source: string): string {
  if (source === LEGACY_NOTE_SOURCE) return "";
  if (source.startsWith("history:")) return `[user, history #${source.slice(8)}]`;
  if (source.startsWith("answer:")) return `[ask_user answer ${source.slice(7)}]`;
  if (source === "original_task") return "[user, original task]";
  return "[user]";
}

/** A user input whose text is cut to about `maxBytes`, largest text block first; other blocks are kept. */
export function cutUserInput(input: UserInput, maxBytes: number, pointer: string): UserInput {
  if (typeof input === "string") return cutText(input, maxBytes, pointer);
  const blocks = input.map((block) => ({ ...block }));
  const texts = blocks.flatMap((block) => block.type === "text" ? [block] : [])
    .sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text));
  let over = texts.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0) - maxBytes;
  for (const block of texts) {
    if (over <= 0) break;
    const size = Buffer.byteLength(block.text);
    block.text = cutText(block.text, Math.max(0, size - over), pointer);
    over -= size - Buffer.byteLength(block.text);
  }
  return blocks;
}

/** Whether `input` was cut naming `pointer`. */
export function cutNames(input: UserInput, pointer: string): boolean {
  const marker = `[… cut; full text: ${pointer}]`;
  return typeof input === "string" ? input.includes(marker) : input.some((block) => block.type === "text" && block.text.includes(marker));
}

/** Text bytes of a user input. */
export function userTextBytes(input: UserInput): number {
  return typeof input === "string" ? Buffer.byteLength(input)
    : input.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
}

/** `text` head/tail-cut to about `maxBytes` around a marker naming where the full text is kept. */
export function cutText(text: string, maxBytes: number, pointer: string): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = `\n[… cut; full text: ${pointer}]\n`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const head = utf8Prefix(text, Math.floor(room / 2));
  return head.text + marker + utf8Suffix(text, room - head.bytes).text;
}

function renderEntry(entry: LedgerEntry, maxBytes?: number): string {
  const body = maxBytes === undefined ? entry.content : cutText(entry.content, maxBytes, ledgerPointer(entry.source));
  const label = ledgerLabel(entry.source);
  return label ? `${label}\n${body}` : body;
}

/**
 * The `## User messages` body (design §6.2, §6.2.1). `pinned` entries (the current request, then its answers) are kept
 * whole; the rest are taken newest first while they fit `budgetTokens`, and the first that does not fit is head/tail-cut
 * with a pointer to its full text. Output is oldest first.
 */
export function renderLedger(entries: readonly LedgerEntry[], options: { pinned: ReadonlySet<string>; budgetTokens: number;
  tokens: (text: string) => number; note?: string | undefined; limits?: ReadonlyMap<string, number> }): { text: string; tokens: number } {
  const chosen = new Map<number, string>();
  // Each part is costed with its separator, so the parts' sum bounds the joined text.
  const cost = (text: string) => options.tokens(`${text}\n\n`);
  // The legacy coverage line is kept like a pinned entry.
  const pinned = (entry: LedgerEntry) => options.pinned.has(entry.source) || entry.source === LEGACY_NOTE_SOURCE;
  let used = options.note ? cost(options.note) : 0;
  for (const [index, entry] of entries.entries()) {
    if (!pinned(entry)) continue;
    const text = renderEntry(entry, options.limits?.get(entry.source));
    chosen.set(index, text);
    used += cost(text);
  }
  let room = options.budgetTokens - used;
  for (let index = entries.length - 1; index >= 0 && room > 0; index--) {
    const entry = entries[index]!;
    if (pinned(entry)) continue;
    const whole = renderEntry(entry);
    const wholeCost = cost(whole);
    if (wholeCost <= room) { chosen.set(index, whole); used += wholeCost; room -= wholeCost; continue; }
    // The overflowing entry is cut to the room left, sized by the same token estimate; an entry with no useful room is not started.
    let bytes = Math.floor(Buffer.byteLength(whole) * room / wholeCost);
    while (bytes >= 64) {
      const cut = renderEntry(entry, bytes - Buffer.byteLength(ledgerLabel(entry.source)) - 1);
      const over = cost(cut) - room;
      if (over <= 0) { chosen.set(index, cut); used += cost(cut); break; }
      bytes -= Math.ceil(over * Buffer.byteLength(cut) / cost(cut)) + 8;
    }
    break;
  }
  const parts = [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
  const text = [...(options.note ? [options.note] : []), ...parts].join("\n\n") || "(none)";
  return { text, tokens: options.tokens(text) };
}

export function buildCheckpointMessage(parts: { n: number; ledger: string; workingState: string; checkpoint: string }): string {
  return [
    `${CHECKPOINT_MARKER}${parts.n}]`,
    `## User messages (verbatim, oldest first)\n${parts.ledger}`,
    `## Working state\n${parts.workingState || "(omitted to fit the context)"}`,
    `## Checkpoint\n${parts.checkpoint}`,
    `## Resume\n${RESUME_TEXT}`,
  ].join("\n\n");
}

/** A provider validation error about replayed thinking or reasoning items (design §6.2 "Steps keep their reasoning"). */
export function isReasoningRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  // Only an HTTP validation error: Raw's own stream errors mention thinking blocks too.
  if (status !== 400 && status !== 422) return false;
  return /thinking|reasoning|signature|encrypted_content|redacted/i.test(error instanceof Error ? error.message : String(error));
}

export function compactSession(session: AgentSession, options: CompactOptions = {}): Promise<CompactResult> {
  return session.compact(options);
}
