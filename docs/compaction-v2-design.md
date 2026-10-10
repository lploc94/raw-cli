# Compaction v2 design

Design for making compaction lossless where it matters. After a compaction the agent must continue the same step it was on. It must not redo finished work, retry an approach it already rejected, or lose the user's words.

Status: proposed 2026-10-10; Codex (gpt-6-astra) review APPROVE after 4 rounds on 2026-10-10 (15 issues fixed). Phase 1 implemented (checkpoint prompt, rendered transcript, step chunking, `compact.instructions`). Phase 2 implemented (checkpoint message layout, user-message ledger, verbatim tail, size allocation, reasoning retry, `compact.keep_recent_tokens`); phases 3–6 pending. Pilot evidence is in [evidence/compaction-pilot.md](evidence/compaction-pilot.md). Update this file whenever a decision changes. User-facing behavior moves to `context.md` and `configuration.md` as each phase lands.

## Contents

1. Problem
2. How Raw compacts today
3. Industry practice
4. Pilot experiment
5. Principles
6. Design
7. The checkpoint prompt
8. Implementation plan
9. Evaluation harness
10. Decisions

## 1. Problem

Long agent runs cross the context limit. The usual failure after compaction is not a crash but amnesia. The agent:

- forgets what it was in the middle of and starts over,
- re-reads files it had already understood,
- retries a fix it had already ruled out,
- or drifts from the user's latest instruction.

opencode is the public example. Issue #41358 reports goal drift and redoing earlier steps after auto-compaction. The thread attributes it to two causes:

- The loop continues before the summary lands. There is no barrier, and pending user input gets raced over.
- The summary is too weak to resume from.

Reasoning is the hardest thing to keep. Raw stores provider reasoning as `opaque` (Anthropic thinking blocks, Responses reasoning items, OpenRouter `reasoning_details`, DeepSeek `reasoning_content`) and replays it while it is in the active context. A summary cannot carry it, though: once the messages holding it are compacted, whatever the agent concluded survives only if the checkpoint says so.

## 2. How Raw compacts today

Code: `src/compact.ts`, `src/agent.ts` (around lines 836–875).

| Aspect | Today | Consequence |
|---|---|---|
| Prompt | One line: `COMPACT_SYSTEM_PROMPT` ("Summarize prior conversation for continuation. Include objective, constraints, …") | No structure. Nothing asks for the current position, the hypothesis being tested, or rejected approaches. Summaries come out short. |
| Summarizer input | `JSON.stringify({originalTask, previousSummary, olderTurns})`, with full tool results and opaque reasoning blobs | Wastes input on escaped JSON and encrypted reasoning the summarizer cannot read. No prompt-cache reuse, because the system prompt and prefix both change. |
| What is kept verbatim | The first user message of the session (`originalTask`), plus `keep_recent_turns` (2) complete *turns* | One long turn (one user message, hundreds of tool steps) is the normal agent case. Auto-compaction then forces `keep` to 0 (agent.ts `if (keep === starts.length && …) keep--`). The whole current turn becomes summarizer input, including the latest tool result being worked on. If that one turn does not fit the summarizer's context, `performCompaction` cannot split it and throws `compaction input exceeds context budget for one turn`, so the run ends with `compact_error`. When it does fit, the turn is summarized, and if the current request is not the session's first message, the user's words are lost verbatim. |
| Framing | `[Conversation summary]\n<summary>` as a user message | No instruction to resume. The model may recap, ask what to do, or treat it as a new task. |
| Rolling summary | Chunks pass `previousSummary` forward | No merge rules, so a later chunk can silently drop earlier constraints. |
| Frequency | At most one auto-compaction per turn (`autoCompacted`) | A long turn that fills the window again either errors (`context_budget_exceeded` when measured) or sends an oversized request. |
| Failure | `compact_error` ends the turn | Contradicts "degrade, never block". |
| Cheap reduction | None. Every reduction is an LLM summary. | Old 50 KB tool outputs that are no longer needed cost a full summarization to remove. |
| After compaction | The skill reload notice and `[Raw panel state]` reminders, such as todo, are re-attached (`context.md`). | These are good and are kept. |

## 3. Industry practice

Sources are saved in `/tmp/compaction-research/` (not committed). The research report is summarized here.

| System | Prompt shape | Kept verbatim | Cheap reduction | Notes |
|---|---|---|---|---|
| Claude Code (reverse-engineered, Piebald) | `<analysis>` scratchpad, then 9 sections: request/intent, concepts, files and code, errors and fixes, problem solving, **all user messages**, pending tasks, **current work**, next step with **verbatim quotes** | Recent messages after the summary; file and plan reminders ("…was read before the last conversation was summarized… Use Read tool if you need to access it") | Not confirmed | Honors "Compact Instructions" from CLAUDE.md. A no-tools guard prefix. |
| Codex CLI | "CONTEXT CHECKPOINT COMPACTION… handoff summary for another LLM"; 4 bullet topics | Newest real user messages up to 20k tokens, then the summary | Remote v2: server-side encrypted compaction item, retained messages capped at 64k | The summary prefix says "build on the work… avoid duplicating work". |
| opencode (current) | Template: Objective / Important Details / Work State (Completed, Active, Blocked) / Next Move / Relevant Files; "keep every section, even when empty"; "preserve exact paths, symbols, commands, error strings" | Most recent 8k tokens as a tail | Pruning: protect newest 40k tokens of tool output, clear older ones to `[Old tool result content cleared]` only if ≥ 20k is freed | Explicit **merge rules** for a prior summary ("anything you do not carry… is lost"; "conversation wins on conflict"). |
| Goose | `<analysis>`, then JSON: intent, concepts, files, errors (quoted verbatim), problem_solving (chosen/rejected/why), user_messages, pending, current_work, next_step | n/a | n/a | "spend your entire length budget", "omit a field rather than inventing" |
| Anthropic API | Server compaction (`compact_20260112`, default trigger 150k input, custom `instructions`) | Configurable recent turns | `clear_tool_uses_20250919`: trigger 100k, keep 3 tool uses | Opaque `compaction` block with signature. |
| OpenAI Responses | `/responses/compact` or `context_management: compaction` | Some items retained | n/a | Opaque encrypted item; prompt unpublished. |

Common lessons:

- Anchor the summary to the **current** goal and the **current** step.
- Keep the user's words and a recent tail verbatim, outside the summary.
- Force every section to appear, even when empty.
- Prune old tool output by rule before summarizing.
- Point at re-readable artifacts instead of copying them.
- Gate the next step on the summary landing.

None of the published prompts has an explicit "rejected approaches" section.

## 4. Pilot experiment

Full method and data: [evidence/compaction-pilot.md](evidence/compaction-pilot.md).

**Setup.**

- Input: a real 200 KB segment of a Raw development session. It covers implementing the limits audit: four committed groups, a fifth uncommitted, and debugging a test failure at the cut. Tool results were pre-truncated to 1,200 characters.
- Each prompt summarized the segment. A fresh model received only the user's message and the summary, then answered 12 recall probes plus "what are your next 3 actions" (Factory-style probes: recall, artifact, decision, continuation).
- A blind Opus judge scored each probe 0–2 against an answer key (max 24) and listed confident wrong facts.

**Results.** Mean recall over runs, out of 24:

| Summarizer | Prompt | Recall | Summary length | Wrong facts per run |
|---|---|---|---|---|
| Sonnet | Raw today (one line) | 16.0 (n=3) | 5.9–7.0 KB | 0.7 |
| Sonnet | Codex | 15.7 (n=3) | 5.7–6.4 KB | 1.3 |
| Sonnet | Claude Code 9-section | 16.3 (n=3) | 7.0–9.1 KB | 1.0 |
| Sonnet | v2 draft (this doc, without length rule) | 16.3 (n=3) | 6.8–8.5 KB | 0.3 |
| Sonnet | **v2 with length and detail rules** | **18.0** (n=3) | 9.9–10.1 KB | 0.3 |
| Opus | Claude Code 9-section | 20.0 (n=2) | 10.2–11.6 KB | ≈1 |
| Opus | **v2 with length and detail rules** | **20.5** (n=2) | 12.1–12.9 KB | ≈1 |
| Opus, full tool outputs | Claude Code's real compaction of this session | 20.3 (n=3 probes) | 16.5 KB | 0 |

Adding the verbatim tail on top of a good summary did not change recall in this segment (v2 17 → 17). The summary already covered the last steps. On the weak one-line prompt, the tail raised the next-action score from 1 to 2.

**What the pilot shows:**

1. **The summarizer model matters most** (about +4/24, Sonnet to Opus). Raw already summarizes with the agent's own model, which is the right default. Never default compaction to a cheaper model.
2. **Models under-use the budget.** Every Sonnet summary was about 2k tokens against a 16k cap. Telling the model this is its only memory and allowing about 4,000 words raised recall by 1.7 on Sonnet. It cost no extra wrong facts.
3. **Section wording among structured prompts barely moved recall.** The structure mattered for *kind* of error instead:
   - The v2 prompt's "(unverified)" marking and its "Rejected and failed" section kept wrong facts lowest.
   - It also kept the debugging hypothesis together with its numbers (estimate 6086 vs trigger 5406).
   - It recorded the trap that a `git stash` comparison is invalid without a rebuild.
4. **Some runs proposed reopening finished work, and no prompt eliminated it.** One Codex-prompt run proposed further B4 work although B4 was committed (judge redo risk 2). One v2 run claimed B4 was only partly committed. Most runs scored redo risk 1: they re-checked a known diagnosis before acting. These are proposals in a quiz, not executed actions.
   - **Hypothesis, not established by these probes:** wholesale restarts after compaction are mainly mechanical. The likely causes are losing the user's current request, losing the step in progress, framing that does not say "resume", and a missing barrier. Raw's turn-based retention has the first two risks in long turns (§2).
   - The behavioral resume test (§9) is what can confirm or refute this.
5. Small one-off facts are lost by every prompt; Q12, a twice-subtracted reserve, averaged 0.5/2. That is acceptable when the fact is re-derivable from `git show`. The prompt should therefore point at re-derivable state instead of trying to copy everything.

**Held-out segment and runbook.** Two follow-ups were run with Sonnet, three runs each:

- a second segment (a Codex review loop cut mid round 2) whose questions and key were written before any run;
- the §7 runbook variant.

| Prompt | Segment 1 | Segment 2 (held-out) |
|---|---|---|
| Raw today | 16.0 | 14.3 |
| Claude Code | 16.3 | 14.7 |
| v2 + length rule | 18.0 | 18.0 |
| v2 + length rule + runbook | 20.0 (22/19/19) | 18.0 (19/19/16) |

The runbook's `<analysis>` block is discarded before probing, as the host would discard it.

What these runs show:

- **v2 generalizes.** It leads by about 3.5 points on unseen material.
- **The runbook adds about 2 points on segment 1 and nothing on segment 2.** On segment 2, most lost points were facts the harness had cut from the input: tool results were limited to 1,200 characters. No prompt can recover those.
- **The runbook makes gaps visible.** The Codex findings for #17 and #18 had been cut from the summarizer's input by the harness's 1,200-character tool-result limit. The runbook summary said so and named where to re-read them (`/tmp/codex_poll.json`), rather than guessing their content. Its first next action was to re-read them.

That last result is the behavior §6.3 needs, and it is also a warning. Truncating old tool results in the summarizer input can drop the very list of work items being worked through.

**Limits.**

- Two segments, one domain.
- An LLM judge, and an answer key that missed some true facts. Two "wrong facts" were verified true in the code and are excluded above.
- Small n.
- Truncated tool outputs in the pilot input.
- Recall probes measure memory, not behavior. The behavioral test, actually resuming in a checkout, is part of the harness in §9.

**Self-observation.** This session was itself compacted once, by Claude Code, mid-task. Work continued with no redo. The only re-lookup was one cheap `git diff`. What made that work:

- the verbatim recent messages, including the last tool output;
- the exact working hypothesis with numbers;
- the user's messages quoted verbatim;
- the ordered pending tasks;
- a concrete next step;
- an instruction to resume without recapping;
- "file was read before compaction, read it again if needed" pointers.

Everything the v2 design keeps maps to one of these.

## 5. Principles

1. **Mechanical before generative.** Anything the host can keep exactly, it keeps exactly. That covers user messages, the recent tail, the todo and panel state, files touched, and saved outputs. The LLM writes only what the host cannot know: conclusions, reasons, rejected paths, and the current hypothesis.
2. **Write for yourself resuming mid-step.** The checkpoint is working memory, not a report.
3. **Point, don't copy.** Re-derivable state (diffs, files, spilled outputs) is referenced by path. Conclusions are copied.
4. **Degrade, never block.** A failed summary falls back to cheaper reductions. A turn is never ended because compaction failed.
5. **Barrier.** No model step starts until the compacted context is committed. Raw's loop is sequential already; this stays a stated invariant.
6. **Cheap first.** Clear old tool results before summarizing. Summarize only when clearing is not enough.

## 6. Design

### 6.1 Layers

| Tier | What | Cost | Trigger |
|---|---|---|---|
| 0 | **Tool-result clearing**: old tool results become stubs that name a saved copy | No model call; changes the prefix once per batch | `clear_tokens` (default 60% of input budget) |
| 1 | **Checkpoint compaction**: the LLM checkpoint plus host-kept verbatim parts | One model call (cache-friendly, §6.6) | `trigger_tokens` (default 80%, unchanged) |
| 2 | **Provider-native compaction** (Anthropic compaction, OpenAI `/responses/compact`) | Provider-side | Opt-in `compact.strategy: "native"` |

### 6.2 Post-compaction context

The active model context after a tier-1 compaction contains, in order:

```
system prompt                                    (unchanged)
user:  [Raw compaction checkpoint #N]
       ## User messages (verbatim, oldest first)   host-kept
       ## Working state                            host-kept
       ## Checkpoint                               LLM-written (§7)
       ## Resume                                   fixed text (§6.4)
<verbatim tail: the last steps, unchanged>       host-kept
[Raw panel state] / [Raw skill reload notice]    existing reminders
```

- **User messages ledger.** Every real user message of the session is kept verbatim, oldest first: typed input and answers to `ask_user`, not tool results. It is capped at 20k tokens, as in Codex. Messages are taken newest first. The message that overflows is head/tail-cut and names where its full text is kept in visible history. This replaces the special case of `originalTask` and fixes the loss of the current request.
  - **Source.** Typed user inputs are `history` rows of kind `user`. Their `(session_id, sequence)` is stable across context replacement, because compaction never rewrites visible history. Answers to `ask_user` come from the committed `builtin/ask_user` tool result, identified by session and tool call ID. The stored entry is the complete answer from the model message, not the visible preview, which is cut at 2,000 characters.
  - **Storage.** The ledger is stored as structured entries `{source, content}`, where `source` is `history:<sequence>` or `answer:<callId>`. It lives in the session's compaction metadata, next to the summary text and the legacy `originalTask`, and is written in the same atomic commit as the context replacement. Entries are appended in the same commit that stores each new user input or answer, so a crash cannot leave the ledger behind the context.
  - **`/clear`** empties the ledger together with the context.
  - **Old sessions** without ledger metadata are reconstructed on first load from `history` rows of kind `user`, plus `originalTask`. Answers to `ask_user` from before the upgrade are recovered only while their tool results are still in the active context; older ones are lost, which is stated in the upgrade note.
- **Working state** (host-generated, deterministic, at most 4 KB):
  - files written or patched in the session, with the last tool that touched each;
  - files read but no longer in context;
  - saved full outputs (`full_output` and spill paths) still on disk;
  - things in flight that Raw owns: background processes from `builtin/process` with their IDs and commands, and pending approvals or questions;
  - the last `bash` command and its exit code;
  - the cwd;
  - number of compactions so far.

  The todo and panel state stay in their existing `[Raw panel state]` reminders.
- **Verbatim tail.** It is chosen by **steps**, not turns. A step is an assistant message together with all of its tool results, so a call and its result are never split. The newest steps are kept until the tail reaches `keep_recent_tokens` (default: the smaller of 20k and 25% of the input budget). At least the last step is always kept. A single result too large for the tail is head/tail-truncated, with its saved copy named. `keep_recent_turns` remains as a lower bound, honored when it fits.
- **Steps keep their reasoning.** A retained step is replayed exactly as stored, including its `opaque` reasoning: Anthropic thinking blocks with signatures, and Responses reasoning items before their function calls. Tier 0 changes only tool-result content, never assistant messages. If a provider still rejects the replayed reasoning after the prefix changed (a validation error about thinking or reasoning items), the request is retried once with the whole affected history projected to portable text, using the existing model-switch mechanism.
  - The boundary is the session's persisted `replayBefore`, raised to the current end of the context: every message that exists when the rejected request was built, for tier 0 and tier 1 alike. This is exactly what a model switch does today (`replayBefore = this.messages.length`). `projectReplayMessages` then turns all of them into portable text without opaque reasoning. No reasoning that could depend on an edited result is left native, and no parallel call/result batch is split, because the boundary falls after the last complete message. Steps produced after the retry keep their native reasoning.
  - The raised boundary is persisted the same way a model switch persists it, so later requests and a restart use the same projection.

#### 6.2.1 Budget allocation

The post-compaction request aims at a **soft target** of 50% of the effective input budget, leaving room for the turn to continue. Items 1–4 below are mandatory and are kept whole up to the **full** effective input budget, even when that exceeds the target. Items 5–7 are optional: they only fill what is left under the target, and are reduced or omitted when nothing is left. A result above the target is then classified by §6.5 (usually weak), so the next crossing goes to the fallback chain rather than looping. Priority order:

1. Fixed parts: the system prompt, tool schemas, `[Raw panel state]` and skill reminders, the resume text.
2. The current turn's request group: the typed input that started the current turn (the newest `history` row of kind `user`), followed by any `ask_user` answers given during this turn, newest first. The request is admitted before its answers, and answers never displace it. The newest ledger entry is not assumed to be the request.
3. The last step (minimum tail).
4. The checkpoint, up to `max_output_tokens`.
5. Working state, up to 4 KB.
6. The rest of the ledger, newest first, up to its 20k cap. The cap is an upper bound, never a reservation.
7. The rest of the tail, newest first, up to `keep_recent_tokens`.

When items 1–4 exceed the full effective input budget, the checkpoint is first shortened to the room left, down to 1,024 tokens, then replaced by the mechanical note of §6.7. If items 1–3 alone still exceed it, the excess is cut by head/tail truncation with a pointer: first the tool results in the last step (to their saved copies), then the current turn's answers, then its request (each to its history entry). This matches the ledger rule for an overflowing message. Nothing is dropped silently, and every cut names where the full text is. If even the truncated minimum does not fit, the measured-budget rule of §6.7 applies.

### 6.3 Summarizer input

- **Rendered transcript, not JSON.** The input is labeled lines (`USER:`, `ASSISTANT:`, `TOOL CALL name(args)`, `TOOL RESULT`).
- **Shortened tool results.** Results older than the tail are head/tail-truncated to 4 KB each, with the saved-copy path. The pilot showed this can hide a list of work items (§4). Two rules limit that:
  - the saved-copy path is always in the marker, so the checkpoint can say where to re-read the result;
  - the cache-friendly path, which sees results whole, is preferred whenever it fits.
- **No opaque reasoning blobs.** Encrypted reasoning is dropped. Readable reasoning text the provider returned is included, because it is where conclusions live.
- **Previous checkpoint.** It is passed as `<prior-checkpoint>` with merge rules (§7).
- **Chunking by steps, not turns.** When the input does not fit the summarizer's context, it is split at step boundaries. A step is never split from its tool results, so one long turn spans several chunks. Each chunk carries the running checkpoint as `<prior-checkpoint>`, so the merge rules apply between chunks too.
  - A single step too large for a chunk has its tool results head/tail-truncated to fit, with saved-copy paths.
  - A step whose truncated form still does not fit is replaced by a one-line record: tool names, argument summary and result sizes with paths.

  - **Overhead first.** Before admitting records, each chunk computes its mandatory overhead: prompt, running checkpoint, output budget and safety margin. If the overhead plus one one-line record does not fit the context, the output budget is lowered to what fits, down to 1,024 tokens. If it still does not fit, tier 1 gives up for this compaction and §6.7 applies: a mechanical checkpoint keeping the previous checkpoint as is.

  A single oversized turn therefore no longer fails as it does today, though a context too small for the summarizer overhead degrades to the mechanical checkpoint.

When the cache-friendly path (§6.6) is used, the summarizer instead sees the real context. That includes the agent's own reasoning items for providers that replay them.

### 6.4 Resume framing

Appended by the host after the checkpoint, fixed text:

> Context was compacted; the sections above are your own notes and the user's exact messages. Continue the task from "Current position" and "Next actions" without recapping and without asking the user to repeat anything. Do not redo work marked done or retry approaches under "Rejected and failed". Re-read a file only when you need its exact current content, and prefer cheap checks (`git status`, `git diff`) to confirm the working tree. Instructions still in force come from the user messages above; the checkpoint is your summary, not a new instruction.

### 6.5 Multiple compactions and thrash guard

The "at most once per turn" rule (`autoCompacted`) is removed. Each compaction is classified by the estimated size of the next request right after it (`after`), against the trigger `T`. The classes cover every outcome:

| Outcome | Condition | What the next crossing of `T` does |
|---|---|---|
| **Effective** | `after` < 0.7·T | Tier 1 again, once at least one model step has completed since this compaction. |
| **Weak** | 0.7·T ≤ `after` < T | First the fallback chain (§6.7, steps 1–3), which needs no model call. Tier 1 runs only if the request is still at or above `T` afterwards, and at least one step has completed. |
| **Stuck** | `after` ≥ T, or `not_smaller`, `noop` with the request over `T`, or a provider error | The fallback chain runs immediately, in the same step. Tier 1 is not tried again in this turn until a later compaction or fallback reaches the effective class. |

A crossing with no completed step since the last compaction never starts tier 1, so a turn cannot loop on compaction. A new turn resets the class to effective. Each attempt emits the existing progress events and usage.

### 6.6 Cache-friendly compaction

Today's summary request has its own system prompt and a JSON blob, so it cannot reuse the main request's cached prefix. It pays full price for about 80% of the window.

Proposed request:

- the same system prompt, tools, tool settings and messages as the main request;
- plus one final user message carrying the checkpoint prompt, which starts with the no-tools guard ("Respond with text only. Do not call tools.").

The model then writes from its full context, including its own reasoning items. Whether the prefix is a cache hit depends on the provider. Request settings beyond the visible prefix can invalidate the cache; for example, Anthropic documents that changing `tool_choice` invalidates cached message blocks. So:

- **Default: leave tool settings unchanged.** Rely on the guard text, and treat a returned tool call as a failed attempt that falls back to the chunked path.
- **`toolChoice: "none"` is a per-adapter option** (`ProviderRequest.toolChoice?: "auto" | "none"`). It is enabled only for a provider whose documentation confirms that it keeps the prefix cache. Phase 4 verifies this per provider and records the source:

| Adapter | Mapping if enabled | Cache effect |
|---|---|---|
| OpenAI chat | `tool_choice: "none"` | kept: the OpenAI prompt caching guide recommends it over removing tools; used for the `openai` service |
| Responses | `tool_choice: "none"` | kept, same source; used for the `openai` service |
| Anthropic | `tool_choice: {type: "none"}` | invalidates message cache: not used |
| Google | `functionCallingConfig.mode: "NONE"` | undocumented for implicit caching: not used |

Sources are recorded in `docs/providers.md` (checked 2026-10-11).

Cache reuse is reported from provider usage (cache-read tokens), never assumed. Tests check the wire settings each adapter sends. A mocked cache count is not proof of reuse.

**Fallback** to the rendered-transcript, chunked path (§6.3):

- when the main context plus the prompt plus the checkpoint budget do not fit;
- when the agent model is not the compaction model (`CompactOptions.provider`);
- when the request fails.

### 6.7 Failure and fallback (degrade, never block)

Order on a failed or stuck tier 1:

1. Tier-0 clearing of everything outside the tail, regardless of `clear_tokens`.
2. A mechanical checkpoint. The ledger, working state, previous LLM checkpoint (if any) and tail are kept. A one-line note replaces the new LLM checkpoint: `[Checkpoint unavailable: <reason>; older steps were removed. Re-check the working tree before continuing.]`
3. Shrink the tail step by step, keeping at least the last step.
4. Check the result with the existing rule, unchanged. If the size is anchored to provider-reported usage and still exceeds the input budget, the turn ends with `context_budget_exceeded`. Only the truncated minimum of §6.2.1 can be left at that point, so the context genuinely cannot hold the request. If the size is only a byte estimate, the request is sent, and a provider rejection surfaces as that provider error, not as a compaction failure.

`compact_error` is no longer a turn outcome for automatic compaction; it becomes a warning event. The turn can still end with `context_budget_exceeded` (step 4) or a provider error from the main request, and these stay distinct from the compaction warning. Manual `/compact` still reports a provider error, because the user asked for that specific operation.

### 6.8 Tier-0 tool-result clearing

- **Eligible results.** A tool result is eligible when it is older than the protected tail (`keep_recent_tokens`) and larger than 2 KB.
- **Stub.** It is replaced by `[Old tool result cleared: <tool> <short args>, <N> bytes; full output: <path>]`.
- **Saved copy.** A result is cleared only when a complete, readable copy is secured first:
  - an existing `full_output` copy counts only if the file exists, is not marked capped, and its size matches;
  - otherwise the result is written through the spill store (`src/tools/spill.ts`);
  - if saving fails, the file would be capped (over 64 MiB), or the spill aggregate is full, the result is **not** cleared and stays in context.

  The stub names the path and says retention is best effort: `full output: <path> (saved copy, normally kept 7 days; may be removed earlier when saved outputs exceed their disk limit)`. The spill store's 1 GiB aggregate eviction can delete a copy before 7 days. When the copy is gone, `read_file` reports the file missing, which the stub already warned about. Guaranteed retention would be a separate decision.
- **Hysteresis.** Clearing starts at `clear_tokens` and continues until the estimate is at most 45% of the input budget. It runs only if it frees at least 20k tokens, so the cached prefix changes rarely; opencode uses `PRUNE_MINIMUM` the same way.
- **Never cleared:** the user ledger, `load_skill` results (they have their own reload notice), and results named in panel reminders.
- **Durability.** Clearing is a context replacement with the same commit boundary as compaction. Visible history is untouched.

### 6.9 Provider-native compaction (tier 2, optional)

- **Anthropic** compaction beta and **OpenAI** Responses compaction return opaque items, which are stored as `opaque` on a synthetic message.
- The prompt is supplied through `instructions` (Anthropic) where supported, so the checkpoint sections are the same.
- The host-kept ledger and working state are still added, because they are deterministic.
- This is off by default. It is useful for very long sessions where the provider can compact without a separate request.
- **Needs its own design addendum before phase 6 starts.** This section only reserves the slot. The addendum must specify, per provider:
  - the exact stored and outgoing message layout;
  - where the host ledger, working state and reminders go relative to the compaction item;
  - preservation of all returned output items;
  - required beta headers;
  - restoration after restart;
  - behavior when the session switches provider or model (the native item cannot be replayed elsewhere, so fall back to the last tier-1 checkpoint or a projection);
  - fallback to tier 1 on errors.

  §6.9.1 is that addendum.

#### 6.9.1 Addendum: provider-native compaction

Sources, checked 2026-10-11:

- Anthropic: [Compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand), [Compaction that keeps recent turns](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns), [Compaction and preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks), and the SDK types `BetaCompactionConfig` and `BetaCompactionBlock` (`@anthropic-ai/sdk` 0.128.0).
- OpenAI: the [Compaction guide](https://developers.openai.com/api/docs/guides/compaction), the [`/responses/compact` reference](https://developers.openai.com/api/reference/resources/responses/methods/compact), and the SDK types `ResponseCompactParams`, `CompactedResponse` and `ResponseCompactionItem` (`openai` 7.23.0).

**What native replaces.** Only the checkpoint body of a tier-1 compaction. Everything else stays as in §6.2–§6.8:

- the choice of the verbatim tail and the budget allocation;
- the ledger, working state, resume text, skill notice and panel reminders;
- the thrash guard and the fallback chain.

The mechanical fallback (§6.7) never uses native.

Raw uses the on-demand forms: Anthropic's `compaction` parameter and OpenAI's `/responses/compact`. In both, Raw decides when to compact, and the result is a value Raw stores. Threshold forms (Anthropic `context_management` and OpenAI `context_management.compact_threshold`) compact inside an ordinary request. They would bypass the ledger and the thrash guard, so they are not used.

**When native is tried.** With `compact.strategy` `"checkpoint"` (the default) native is never considered and nothing new is emitted. With `"native"`, all of these must hold, otherwise the compaction is a normal tier-1 checkpoint:

- the compaction runs on the agent's own provider (not `compact.model` or another provider passed to a manual compaction);
- the adapter offers native compaction (Anthropic Messages or OpenAI Responses);
- no step of the verbatim tail is replayed as projected text (§6.2: after a model switch or a reasoning rejection, until those steps leave the tail);
- native has not failed with a permanent error earlier in this process;
- for Anthropic, when a tail message carries a `thinking` or `redacted_thinking` block, the kept-thinking conditions hold (see below).

When `"native"` is configured, each of these fallbacks emits one `compact_warning` event naming the reason. A reason that cannot change, such as an unsupported adapter, warns once per session.

**Native input.** Raw sends the stored messages before the tail exactly as the last main request sent them (same replay projection, same image projection). That includes a previous native item, an earlier host checkpoint message and earlier reminders. The model, system prompt and tools are the main request's.

**Kept-thinking conditions (Anthropic).** Thinking in the tail stays valid only if the tail directly follows the summarized messages, unchanged, and `system` and `tools` do not change. The native input above meets the second part. The first part is checked when the tail carries thinking:

- **Opposite roles at the cut.** The last summarized message and the first tail message have different Anthropic roles. A tool result counts as `user`. Otherwise the API merges them.
- **Contiguous tail.** No message inside the tail range is dropped. A panel reminder, skill notice or host checkpoint message there would be replaced, so its presence fails the check.
- **Unchanged tail.** Only the last step's tool results may be cut (§6.2.1). They follow the last thinking block, so no kept thinking depends on them; every other tail message is kept byte-for-byte.

If a check fails, the compaction is a tier-1 checkpoint, with a warning. If the API still rejects the kept thinking on the next request, the reasoning-rejection retry of §6.2 sends the projection, and the turn continues.

**Anthropic.**

- **Request.** `POST /v1/messages` (`client.beta.messages.create`, not streamed) with:
  - the beta header `anthropic-beta: compact-2026-09-04`;
  - `compaction: {type: "summarize", instructions}`;
  - the main request's model, `system`, `tools`, thinking, effort, service tier and cache settings;
  - `max_tokens` set to the checkpoint output budget of §6.2.1.

  No `tool_choice`, `stop_sequences`, `output_config.format` or `context_management` is sent; the API rejects them with `compaction`.
- **Instructions.** The §7.2 checkpoint prompt with `compact.instructions` appended, led by the no-tools guard. The `<analysis>` step is replaced by "go through the checklist in your thinking": the returned block is signed, so Raw cannot strip an analysis section from it. Instructions over the documented 16,384-character limit fall back to tier 1.
- **Success.** `stop_reason` is `"compaction"` and `content` is exactly one block of type `compaction` with non-empty string `content`. Any other result is a native error. That includes `max_tokens`, `tool_use`, `refusal`, `end_turn` with empty content, and `model_context_window_exceeded`.
- **Stored layout.** Each line is one message:
  1. assistant `{text: <block.content>, toolCalls: [], opaque: [<the block exactly as returned>]}`;
  2. the verbatim tail, unchanged;
  3. user `[Raw compaction checkpoint #N]` with the ledger, working state, a one-line checkpoint body ("The provider-native summary at the start of the context covers the older steps.") and the resume text;
  4. the skill notice and panel reminders, if any.

  The block is first, as the API requires. The host message comes after the tail, because a message between the block and the kept turns would break their thinking. The next compaction, of either strategy, treats a host checkpoint message after position 0 like a panel reminder: it is replaced and never kept in the tail. `summaryText` is the block's readable `content`. A later tier-1 compaction uses it as `<prior-checkpoint>`, and a mechanical checkpoint keeps it.
- **Outgoing.** The adapter sends an assistant message's `opaque` blocks verbatim, as it does for thinking blocks. A request whose messages carry a `compaction` block also gets `anthropic-beta: compact-2026-09-04`; the API rejects the block without it. Exactly one block is ever sent: a later native compaction replaces the first message, and a tier-1 compaction summarizes it away (it is always step 0, so it is never in the tail).

**OpenAI Responses.**

- **Request.** `POST /v1/responses/compact` (`client.responses.compact`) with:
  - the main request's model, `instructions` (the system prompt), prompt cache key and service tier;
  - `input`, the native input built by the Responses input mapper.

  The endpoint takes no tools, output limit or summarization prompt. The checkpoint prompt and `compact.instructions` therefore do not apply; OpenAI's own compaction writes the item. No beta header is needed.
- **Success.** `output` contains exactly one item of type `compaction` with string `encrypted_content`. Anything else, including an HTTP error, is a native error.
- **Stored layout.** Each line is one message:
  1. assistant `{text: <portable text>, toolCalls: [], opaque: <output, every item as returned>}`;
  2. the verbatim tail;
  3. the host checkpoint message, with the same one-line body;
  4. the notices and reminders.

  The guide says not to prune the compacted window, so the retained user messages are kept even though the ledger repeats them. The item is encrypted, so the portable text is the previous written checkpoint (if any) followed by `[Earlier steps are summarized in an encrypted OpenAI compaction item that only this provider can read.]`. That text is also `summaryText`.
- **Outgoing.** The input mapper already spreads an assistant message's `opaque` array as input items, so the compacted window is sent first and as returned, followed by the tail.

**Restoration.** The native message is an ordinary stored message: `opaque` is persisted as JSON in the same atomic context replacement as tier 1. After a restart, it is sent back unchanged, so the bytes of the block or items match what the provider returned.

**Provider, model or tool switch.** A switch already raises `replayBefore` to the end of the context (§6.2). Every message before it, the native one included, is then sent as portable text:

- The native message projects to a user message: `[Earlier conversation summary]` followed by its `text`.
  - For Anthropic, that is the readable summary.
  - For Responses, it is the previous written checkpoint and the note above.
  - It becomes a user message, not an assistant one, so the new provider never receives an assistant-first request.
- The ledger and working state in the host message are provider-independent, so the deterministic part survives every switch.
- The same projection applies when a provider rejects replayed reasoning (§6.2), for example Anthropic thinking in the tail that no longer satisfies the kept-thinking conditions. One retry sends the summary as text, and the turn continues.

**Errors.**

- Any native failure falls back to a tier-1 checkpoint in the same compaction and emits `compact_warning`. Failures include:
  - an HTTP error, a stop reason other than success, or a malformed result;
  - a summary whose placement would overflow the input budget (the signed block cannot be shortened).
- Permanent request errors disable native for the rest of the process: HTTP 400, 404 and 422, or an adapter `invalid_request`. Every other error (rate limit, overload, timeout, `529 compaction_unavailable`) only affects that one compaction.
- Manual `/compact` follows the same rule. Its result is the tier-1 result.
- A cancelled compaction is cancelled, not a native error.

**Not covered.** Background compaction, threshold compaction, Anthropic `tool_changes` handling beyond sending the block back unchanged, and `previous_response_id` chaining (Raw sends `store: false` and full input).

### 6.10 Configuration

New keys under `compact` (all optional):

| Key | Default | Meaning |
|---|---|---|
| `keep_recent_tokens` | min(20000, 25% of input budget) | Verbatim tail budget, by steps |
| `clear_tokens` | 60% of input budget; `false` disables | Tier-0 trigger |
| `instructions` | none | Extra text appended to the checkpoint prompt (like Claude Code's "Compact Instructions") |
| `strategy` | `"checkpoint"` | `"native"` opts into tier 2 where available |

`keep_recent_turns` stays and becomes a lower bound. `max_output_tokens` stays (default 16k).

## 7. The checkpoint prompt

### 7.1 Carry sheet: what survives compaction and who provides it

The model should not have to guess what to keep. Every item is assigned up front to either the host, which copies it exactly, or the model, which fills it in through the runbook checklist.

| # | Item | Provided by | Lands in |
|---|---|---|---|
| 1 | Every user message, verbatim | Host (ledger) | `## User messages` |
| 2 | The last steps: tool calls with their results | Host (verbatim tail) | after the checkpoint |
| 3 | Todo / panel state | Host (existing `[Raw panel state]`) | reminder |
| 4 | Files written or patched; files read and no longer in context | Host (working state) | `## Working state` |
| 5 | Saved full outputs still on disk | Host | `## Working state` |
| 6 | Background processes and pending approvals or questions | Host | `## Working state` |
| 7 | Last bash command and exit code | Host | `## Working state` |
| 8 | Goal, latest instruction, constraints in force | Model, checklist 1 | Goal |
| 9 | Every work item ID with its status | Model, checklist 2–3 | Plan and status |
| 10 | Commits (hash, scope, pushed or not), uncommitted edits | Model, checklist 4–5 | Working tree |
| 11 | Last verification: command, counts, failing names, error line | Model, checklist 6 | Verification |
| 12 | Errors: message → cause → fix | Model, checklist 7 | Decisions / Knowledge |
| 13 | Behavior changed: old → new values | Model, checklist 8 | Plan and status |
| 14 | Decisions, pushback and the argument used | Model, checklist 9 | Decisions and reasons |
| 15 | Rejected approaches, traps, misleading signals | Model, checklist 10 | Rejected and failed |
| 16 | Work in flight outside Raw (review sessions, remote jobs, temp files) and the command to resume each | Model, checklist 11 | Knowledge to keep |
| 17 | How work is done here: edit method, test and build commands, commit format, required steps | Model, checklist 12 | Knowledge to keep |
| 18 | Current hypothesis with evidence numbers, last actions, next step | Model, checklist 13 | Current position / Next actions |
| 19 | Facts missing from view (cut or omitted) and where to re-read them | Model, rule | wherever they belong, marked |

Host items cost nothing and cannot be wrong, so the model is told they exist and must not repeat them. The checklist is generic. It was derived from the probe categories (recall, artifact, decision, continuation), not from the pilot's specific questions. On the held-out segment it scored no lower than without it (§4).

### 7.2 Prompt text

The final text sent as the compaction instruction. In the cache-friendly path it is the last user message. In the fallback path it follows the rendered transcript, and the no-tools guard is added.

```text
You are checkpointing your own working memory. The conversation above is about to be deleted from your context. After this, you will continue the same task with only: the system prompt, the user's messages (kept verbatim by the host), the last few steps (kept verbatim), and the checkpoint you write now. Anything you leave out is gone, including your reasoning, which the host never keeps.

Write the checkpoint for yourself, not for the user. The test is: after reading it, you resume mid-step without re-reading files you already understood, without re-running work that is done, and without retrying an approach you already rejected.

Rules:
- Use only facts from the conversation. Mark anything you inferred but did not verify as "(unverified)".
- Keep exact identifiers: file paths with line numbers, function and type names, commands, config keys, commit hashes, test names, error strings, numbers. Quote error messages and the user's own words exactly.
- Say where something can be re-derived cheaply (`git diff`, a file path and line range, a saved output file) instead of copying it. Copy only what would be expensive or impossible to recover: conclusions, measurements, reasons, and text that is no longer on disk.
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
Files changed and not yet committed, with a few words on what changed in each. Then recent commits made in this task, hash and subject. Point at `git diff` or `git show` for detail.

## Verification
What has been checked and the result: tests, builds, typechecks, manual runs. Exact names of anything failing and the exact error line.

## Knowledge to keep
Facts learned about the code, tools, or environment that are needed to finish and are costly to rediscover: how a mechanism works, conventions this repo follows, commands that work, locations of key code (path:line).

## Next actions
The immediate next action, concrete enough to execute without thinking (command, file, edit). Then the following steps in order, up to the end of the plan.
```

- The status rule ("Take each item's status from what the conversation last reported…") was added on 2026-10-10 by user decision, after the phase 1 qualification. In one of three Opus runs, a checkpoint downgraded a committed item to "partially done" by comparing it with the original proposal, and the resumed agent proposed redoing it (redo risk 2). The re-measured result is recorded in the plan's Progress Log.
- The host keeps only the text after `</analysis>`. The checklist notes used about 10–15% of the output in the pilot and count against `max_output_tokens`.
- `{WORDS}` is min(4000, `max_output_tokens` × 0.6), rounded. 4,000 is the value the pilot measured, and the bound keeps the length rule within a small configured cap.
- "Write in English" keeps the checkpoint compact and model-neutral. The user's words stay in their own language through the ledger and the quotes.
- When a previous checkpoint exists, this block is prepended (adapted from opencode):

```text
<prior-checkpoint> is your checkpoint from an earlier compaction; everything before it is gone. Write one new checkpoint that replaces it:
- Carry forward goals, constraints, user instructions, decisions, rejected approaches and open items from <prior-checkpoint> even when the newer conversation does not mention them. Drop only what is finished and no longer needed to continue.
- The newer conversation wins on conflict: state the corrected fact and drop the old claim.
- Move finished items to [done] with their evidence. Update "Current position" and "Next actions" to the latest state.
```

- **The fallback (no-tools) path** additionally starts with: `Respond with text only. Do not call tools; you have everything you need above.`
- **`compact.instructions`** is appended last, under `Additional instructions from the agent configuration:`.

## 8. Implementation plan

Each phase is one commit with tests and docs, and each goes through codex-impl-review before commit. Phases 1–3 deliver most of the value. 4–6 are cost and reach.

**Phase 1: checkpoint prompt, ledger, step tail, resume framing** (`src/compact.ts`, `src/agent.ts`, `docs/context.md`)

- Changes:
  - Replace `COMPACT_SYSTEM_PROMPT` with the §7 prompt, the merge block and the no-tools guard.
  - Render the transcript as text with head/tail-truncated old tool results, and drop opaque blobs (§6.3).
  - Add the user-message ledger and remove the `originalTask`-only rule; keep reading `originalTask` from old sessions.
  - Select the step-based tail by `keep_recent_tokens`, never splitting a call from its result.
  - Add the working-state block and the resume text.
  - Persist the ledger source (user message indexes) with the session.
- Tests:
  - Compacting a single long turn keeps the current user message verbatim and the last steps verbatim.
  - Tool call/result pairing stays valid for all four adapters' message builders.
  - The ledger is capped at 20k, with the newest messages kept whole.
  - A second compaction merges the previous checkpoint.
  - Old sessions with `originalTask` still load, and their ledger is reconstructed from history.
  - Restart after a compaction keeps the ledger, including an answered `ask_user` question.
  - A single long turn larger than the summarizer context compacts in step chunks instead of failing.
  - A running checkpoint so large that the chunk overhead does not fit lowers the output budget, or else falls back to the mechanical checkpoint.
  - The current request is admitted before a newer `ask_user` answer.
  - Mandatory items above the 50% target but within the full budget are kept whole, with optional items omitted.
  - A tail with an Anthropic thinking block plus tool use, and a Responses reasoning item plus function call, replays unchanged. A simulated reasoning validation error retries with the projected tail.
  - Budget allocation: the current request and last step survive at the target. An oversized current request is head/tail-cut with a pointer, never dropped.
- Acceptance: the pilot harness (§9) on the pilot segment with the agent's model reaches ≥ the Opus Claude Code baseline (20/24). No probe answer contradicts the key on the next action.

**Phase 2: multiple compactions per turn, thrash guard, degrade on failure** (`src/agent.ts`)

- Changes:
  - Remove `autoCompacted`.
  - Add the progress and size conditions (§6.5).
  - Add the fallback chain (§6.7), with `compact_error` becoming a warning event for automatic compaction.
- Tests:
  - A turn whose tool outputs refill the window compacts twice and completes.
  - A failing summarizer degrades to a mechanical checkpoint and the turn continues.
  - A stuck compaction does not loop.
  - A compaction ending between 0.7·T and T (weak), followed by output that crosses `T` again, runs the fallback chain before any second tier-1 call.
  - After all fallbacks, a measured overflow ends with `context_budget_exceeded` and an estimate-only overflow is sent. Both are reported separately from the compaction warning.
  - Manual `/compact` still reports provider errors.

**Phase 3: tier-0 tool-result clearing** (`src/compact.ts` or new `src/context-clearing.ts`, `src/tools/spill.ts`, `src/agent.ts`)

- Changes:
  - Stubs with saved copies, hysteresis and minimum batch (§6.8).
  - `clear_tokens` config.
  - Exemptions for `load_skill` results, panels and the ledger.
- Tests:
  - Clearing frees at least the minimum or does nothing.
  - A result whose copy cannot be saved, or would be capped, is kept in context.
  - Setup: a parallel call/result batch with only its first result cleared, followed by later assistant reasoning. A reasoning validation error raises the persisted `replayBefore` to the end of the context, projecting the whole batch and the later reasoning. A restart keeps that projection, and new steps replay natively.
  - Stub text states best-effort retention. A stale `full_output` path (missing or size-mismatched) is not trusted.
  - A stub names a readable file whose content equals the original result.
  - Recent steps are untouched.
  - Cache key and prefix change only on a clearing batch.
  - Resume from a stored session with stubs.

**Phase 4: cache-friendly compaction** (`src/llm/types.ts`, all four adapters, `src/compact.ts`)

- Changes:
  - Add `ProviderRequest.toolChoice`.
  - Use the same-prefix compaction request, with fallback to the chunked path (§6.6).
- Tests:
  - Each adapter sends unchanged tool settings by default, and its `none` mapping only where enabled.
  - A returned tool call falls back to the chunked path.
  - The fallback is taken when the context does not fit or the providers differ.

**Phase 5: compaction instructions and config docs** (`src/config.ts`, `schemas/`, `docs/configuration.md`, `configure_raw` and `create_agent` skills)

- Changes: add `compact.instructions`, `keep_recent_tokens`, `clear_tokens` and `strategy` with validation.

**Phase 6 (optional): provider-native compaction** (`src/llm/anthropic.ts`, `src/llm/responses.ts`)

- Changes: first, the design addendum required by §6.9. Then the `strategy: "native"` path with opaque compaction items, falling back to tier 1 on unsupported models and on provider switch, with restoration tests after restart.

**Not planned:**

- A cheaper compaction model by default. The pilot shows model strength dominates.
- Pausing for user confirmation after every auto-compaction. Raw's loop already has the barrier, and asking would block unattended runs.

## 9. Evaluation harness

`evals/compaction/` (outside `npm test`; run with `npm run eval:compaction`, needs a provider key):

- **Fixtures.** Recorded synthetic sessions, not private transcripts. Each has an answer key covering:
  - plan status, commits, the current failure and hypothesis, rejected approaches, user constraints;
  - the next action and redo traps.

  At least three shapes: a long single turn mid-debugging, a multi-turn feature with a changed user instruction, and a session already compacted once.
- **Untruncated input.** Fixtures feed the summarizer exactly what Raw would, never a pre-shortened transcript. The pilot's 1,200-character cut caused most of the remaining lost points.
- **Recall probes.** Summarize with the configured model, probe with a fresh request, and score with a blind judge (0–2 per probe) plus a wrong-fact list. This is the pilot method, scripted from `/tmp/compact-pilot/` (`run.sh`, `probe.sh`, `judge.sh`).
- **Behavioral resume test.**
  1. Check out a fixture repository at the cut point.
  2. Compact.
  3. Let the agent run N steps with tools.
  4. Fail if it rewrites a committed file without cause, re-runs a finished group, retries a rejected approach, or asks the user to repeat themselves.
- **Report.** Recall mean ± spread over 3 runs, wrong facts per run, next-action score, redo events, and compaction input/output tokens with cache reads.

## 10. Decisions

Decided by the user on 2026-10-10:

1. **Ledger cap:** 20k tokens, newest first, as in Codex. The overflowing message is head/tail-cut with a pointer to its full text.
2. **Checkpoint language:** English. The user's words are quoted verbatim in their original language.
3. **Tier-0 defaults:** start at 60% of the input budget, clear down to 45%, and free at least 20k per batch. Retune once the harness exists.
4. **Native strategy (phase 6):** kept in the plan as the last phase and opt-in through `compact.strategy: "native"`.
