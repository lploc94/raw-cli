# Compaction prompt pilot (2026-10-10)

Evidence for [compaction-v2-design.md](../compaction-v2-design.md) §4. The question was which compaction prompt lets an agent resume without forgetting what it did, decided and was about to do.

## Method

1. **Input.** A 204 KB text rendering of a real Raw development session segment, which is not committed because it is a private transcript. It covers implementing the limits audit:
   - groups 1–4 committed (`83d1000`, `e91084b`, `4cbf69d`, `5b4e583`);
   - group 5 edited but not committed;
   - the segment ends while debugging two failing `tests/tool-ui-workflow.test.ts` cases.

   Each tool result is cut to 1,200 characters (65% head, 35% tail). User and assistant text is kept whole.
2. **Summarize.** `claude -p --tools ""` with the variant prompt appended after `<conversation>…</conversation>`. When an `<analysis>` block is present it is discarded and only `<summary>` is kept, as Claude Code does.
3. **Probe.** A fresh request receives:
   - the user's message verbatim (the host ledger);
   - the summary;
   - for the "+ tail" variants, the last 15.5 KB of the segment verbatim.

   It answers 13 questions from that context alone, with "unknown" allowed.
4. **Judge.** A blind Opus request scores Q1–Q12 against the key (2 correct, 1 partial or vague, 0 wrong, missing or "unknown"). For Q13 it scores:
   - next action (0–2),
   - plan completeness (0–2),
   - redo risk (0 none, 1 minor re-investigation, 2 redoes finished work).

   It also lists confident wrong facts. Two listed "wrong facts" were checked against the code and are true:
   - spilled outputs are kept 7 days (`SPILL_RETENTION_MS`);
   - commit `a6a36d7` exists before the segment.

   They are excluded from the counts in the design doc.

Variant prompts:

- **Raw today:** `COMPACT_SYSTEM_PROMPT`.
- **Codex:** `codex-rs` `compact/prompt.md`.
- **Claude Code:** the reverse-engineered 9-section prompt with its analysis preamble (Piebald, ccVersion 2.1.290).
- **v2 draft:** the design doc §7 prompt without the two length and detail rules.
- **v2 + length rule:** §7 with `{WORDS}` = 4000.

## Questions

Answer each question from the context above only. If the context does not tell you, write "unknown" rather than guessing. Be specific (hashes, names, numbers).

Q1. List the commits made so far in this task: hash and what each one covered.
Q2. Of the audit items (A1–A11, B1–B7), which are committed, which are edited but not committed yet, and which are not started?
Q3. Which tests are failing right now, and what is the current diagnosis of why?
Q4. What pitfall about running the dashboard "built" tests was discovered, and what does it imply for how you test?
Q5. What exactly is the new default for compact `trigger_tokens` (formula), and how does a user turn automatic compaction off?
Q6. When bash output exceeds the budget, what is kept, what marker does the model see, which field names the saved copy, and how large can the saved copy be?
Q7. What are the hook limits now (timeout default and max, input and output size), and when does the 2 s window still apply?
Q8. How long does a dashboard/process approval wait now, and what can shorten it?
Q9. What is the model-request retry and timeout policy now?
Q10. What did the user ask for in addition to the audit list, in their own terms?
Q11. What working conventions has this task followed (commit granularity, how edits are applied, generated directories, commit trailer)?
Q12. What bug was found and fixed in the byte accounting of src/tools/results.ts?
Q13. You are now resuming work. Write the exact next 3 actions you will take (commands or edits), then the remaining steps until the user's request is complete.

## Answer key

Q1. 83d1000 group 1: tool output (A1 64 KiB budget, A2 bash head/tail + spill to file, A3 process pages, A4 MCP/plugin/ACP truncation note + saved copy, A5 ask_user 64 KiB). e91084b group 2: A6 Anthropic max_tokens fallback 32000 (bounded to 1/8 of context, retry with stated max), A7 no forced 1024 cap with trigger_tokens, continue answers cut by output limit (up to 8 times), truncated tool-call JSON -> invalid_arguments, compaction summary retried once with 2x budget. 4cbf69d group 3: A8 timeout bounds stream silence (600000 ms) + retries. 5b4e583 group 4: A9 approvals 24 h, A10 hooks keep their timeout, A11 sessions 30 days, B4 hook limits.
Q2. Committed: A1–A11, B4. Edited, uncommitted (group 5): B1 summaryFits uses token estimate (estimateRequestTokens) instead of 1 byte = 1 token; B2 default auto-compact trigger at 80% of input budget with `false` to disable; plus budget error gated on measured size, DeepSeek stream_options include_usage, configure_raw skill still had max_output_tokens 512, docs (context.md, configuration.md, config-design.md, create_agent SKILL.md). Not started: B3 MCP per-server timeout_ms, B5 image downscale, B6 dashboard @ file search follow .gitignore instead of skipping dot paths / 20k cap, B7 panel diff shows changed region not first 3 KB.
Q3. Two tests in tests/tool-ui-workflow.test.ts: "built tools coexist across turns, answer/turn/control retries and SSE reconnect without side-effect replay" (workflow state did not settle) and "a killed built dashboard recovers process/question ownership..." (operation state 'error' instead of 'completed'). Diagnosis: the dashboard fixture declares a context window of 8192, so the new default auto-compact turns on (compactTrigger 5406, estimate 6086, inputBudget 6758) and the turn errors in compaction. The two auto-compact.test.ts chunk tests were already fixed (11 pass).
Q4. The "built" tests run against dist/, so a code change (or git stash comparison) needs `npm run build` first; the stash comparison without rebuild was unreliable.
Q5. floor(0.8 * (context − outputReserve − max(64, ceil(0.05 * context)))) when the model declares context_window_tokens (defaultTriggerTokens in src/config.ts); `"trigger_tokens": false` keeps compaction manual.
Q6. The start (about a fifth) and the end of stdout/stderr around "…[N bytes omitted; full output: path]…"; field full_output; complete interleaved output up to 64 MiB in a private per-process temp directory.
Q7. Hook timeout_ms default 60000 (was 5000), max 600000 (was 30000); input up to 64 MiB (was 1 MiB), output 1 MiB (was 64 KiB). The shared 2 s window applies only to cleanup of an interrupted run.
Q8. 24 hours, independent of the model timeout; RAW_APPROVAL_TIMEOUT_MS shortens it; interrupting still cancels.
Q9. request_timeout_ms (default 600000) bounds silence between stream events, restarting on each event. Failures before any stream event with 408/409/425/429/5xx/529 or connection errors are retried up to 3 times with exponential backoff and jitter, honoring retry-after(-ms) capped at 60 s; errors after streaming starts, client errors (401/403/404) and aborts are not retried.
Q10. For A2: when output exceeds the max, save it somewhere the model can read the full output, with a reminder that output was truncated and where to read the full output, like Claude/Codex ("kiểu của claude/codex").
Q11. One commit per group with tests and docs; edits via a python3 `sub(path, old, new)` exact-replace helper; examples/ is regenerated by the build so only source is edited; commits end with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; full npm test before committing; tool definition hash in tests updated deliberately when bash description changed.
Q12. The reserve for the truncation notice line was subtracted twice (fix: add noticeReserve back to remaining).
Q13. Expected: make the dashboard workflow fixture not auto-compact (set compact trigger_tokens false by default in the fixture, or otherwise avoid the 8192 trigger), rebuild (npm run build), rerun tests/tool-ui-workflow.test.ts then the full suite, commit group 5 (B1, B2 and related), then do B3, B5, B6, B7 (each committed with tests/docs). Redo risk: proposing to redo/recommit anything in groups 1–4, re-implement B1/B2, or re-investigate from scratch.

## Per-run scores

| Variant | Run | Q1–Q12 scores | Recall /24 | Next action | Redo risk |
|---|---|---|---|---|---|
| Sonnet / Raw today | A | 2 1 2 1 1 1 2 1 1 2 1 0 | 15 | 1 | 1 |
| Sonnet / Raw today | A2 | 1 1 1 1 2 2 2 1 1 2 1 0 | 15 | 1 | 1 |
| Sonnet / Raw today | A3 | 1 1 2 2 1 2 2 2 2 2 1 0 | 18 | 1 | 1 |
| Sonnet / Codex | B | 1 1 2 2 2 2 2 1 1 2 1 0 | 17 | 1 | 1 |
| Sonnet / Codex | B2 | 1 1 1 2 1 2 2 1 1 2 1 0 | 15 | 1 | 2 |
| Sonnet / Codex | B3 | 1 1 2 2 1 1 2 1 1 2 1 0 | 15 | 1 | 1 |
| Sonnet / Claude Code | C | 1 1 2 2 2 1 1 2 1 2 1 2 | 18 | 2 | 0 |
| Sonnet / Claude Code | C2 | 1 1 2 1 1 1 0 1 1 2 1 2 | 14 | 1 | 1 |
| Sonnet / Claude Code | C3 | 0 1 2 2 2 1 1 2 1 2 1 2 | 17 | 2 | 1 |
| Sonnet / v2 draft | D | 1 1 2 2 2 1 2 2 1 2 1 0 | 17 | 1 | 1 |
| Sonnet / v2 draft | D2 | 1 1 2 2 2 1 1 1 1 2 1 0 | 15 | 1 | 1 |
| Sonnet / v2 draft | D3 | 1 2 1 2 1 2 2 2 1 2 1 0 | 17 | 1 | 1 |
| Sonnet / v2 + length rule | L | 1 2 2 2 2 2 2 2 1 2 1 0 | 19 | 1 | 1 |
| Sonnet / v2 + length rule | L2 | 2 1 2 2 1 2 2 1 1 2 1 0 | 17 | 1 | 1 |
| Sonnet / v2 + length rule | L3 | 2 1 2 2 2 2 2 1 1 2 1 0 | 18 | 1 | 1 |
| Sonnet / v2 draft + tail | E | 1 1 2 2 2 1 2 2 1 2 1 0 | 17 | 1 | 1 |
| Sonnet / Claude Code + tail | F | 0 1 2 2 2 1 1 1 1 2 1 1 | 15 | 2 | 0 |
| Sonnet / Raw today + tail | G | 1 1 1 2 2 1 2 1 1 2 1 0 | 15 | 2 | 1 |
| Opus / Claude Code | Co1 | 1 1 2 2 2 2 2 1 1 2 1 2 | 19 | 2 | 1 |
| Opus / Claude Code | Co2 | 1 1 2 2 2 2 2 2 2 2 1 2 | 21 | 2 | 0 |
| Opus / v2 + length rule | Eo1 | 1 2 2 2 2 1 2 1 1 2 1 2 | 19 | 1 | 1 |
| Opus / v2 + length rule | Eo2 | 1 2 2 2 2 2 2 2 2 2 1 2 | 22 | 1 | 1 |
| Real Claude Code compaction (Opus, full outputs) | R | 1 1 2 2 2 2 2 2 2 2 1 2 | 21 | 1 | 1 |
| Real Claude Code compaction (Opus, full outputs) | R2 | 1 1 2 2 2 2 1 1 2 2 1 2 | 19 | 1 | 1 |
| Real Claude Code compaction (Opus, full outputs) | R3 | 1 1 2 2 2 2 2 2 2 2 1 2 | 21 | 1 | 1 |
| Real compaction + tail | RT | 1 1 2 2 2 2 2 1 2 2 1 2 | 20 | 1 | 1 |

## Findings

- **Summarizer model strength dominates.** The same input with the Claude Code prompt scored 16.3 with Sonnet and 20.0 with Opus. v2 with the length rule went from 18.0 to 20.5.
- **The length and detail rule** added 1.7 on Sonnet with no extra wrong facts. Without it, every Sonnet summary was about 2k tokens against a 16k cap.
- **Section wording barely changed recall.** It changed the kind of error. The v2 sections kept the debugging hypothesis with its numbers and the "stash comparison is invalid without rebuild" trap, and produced the fewest wrong facts.
- **The verbatim tail** did not add recall on top of a good summary here. It helped the weak one-line prompt's next action.
- **Reopening finished work.** Some runs proposed it:
  - B2 (Codex prompt) planned further B4 work although B4 was committed (judge redo risk 2).
  - One v2 + length run claimed B4 was only partly committed.
  - Most runs scored redo risk 1, re-checking an already-known diagnosis before applying the fixture fix.

  These are proposals in a quiz, not executed actions. Whether restarts are mainly mechanical is a hypothesis for the behavioral test.

## Limits

- One segment, an LLM judge, small n, pre-truncated tool outputs.
- Recall probes measure memory, not behavior. The behavioral resume test is specified in the design doc §9.

## Follow-up: held-out segment and runbook

**Segment 2.** A 101 KB rendering of a later part of the same session: a Codex implementation review of 11 commits.

- It is cut mid round 2, after round 1 fixes were committed (`ff7255d`), #4 was disputed and withdrawn, and #19 was fixed but not committed.
- At the cut, #16–#18 are next.
- Its 13 questions and answer key were written before any run, covering the review setup, rounds, the dispute argument, fixes, procedure rules, a git pathspec failure and the next actions.

Sonnet, three runs each. Recall is out of 24.

| Prompt | Segment 1 | Segment 2 |
|---|---|---|
| Raw today | 15 / 15 / 18 | 16 / 12 / 15 |
| Claude Code | 18 / 14 / 17 | 15 / 15 / 14 |
| v2 + length rule | 19 / 17 / 18 | 19 / 16 / 19 |
| v2 + length rule + runbook (§7 of the design) | 22 / 19 / 19 | 19 / 19 / 16 |

- **Analysis block.** The runbook's `<analysis>` block was stripped before probing. A first scoring run that left it in gave nearly the same results.
- **Lost points on segment 2.** Most were round 2 issue texts (#17, #18) and rebuttal details that the 1,200-character tool-result cut had removed from the summarizer's input. The runbook summaries stated that these were missing and named `/tmp/codex_poll.json` as the place to re-read them.
- **Judge-flagged wrong facts.** Most were not errors:
  - "10 commits" is quoted from the user's skill arguments.
  - The retry delay is read from the `ApiError` message, which is the JSON body.
