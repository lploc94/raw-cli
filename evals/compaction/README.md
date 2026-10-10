# Compaction recall eval

`scripts/eval-compaction.mjs` measures how much an agent remembers after a checkpoint compaction, as described in `docs/compaction-v2-design.md` §9. The pilot behind the design (`docs/evidence/compaction-pilot.md`) used the same method.

For each run, the script does three things:

1. **Summarize.** It builds the summarizer request from Raw's own code: the rendered transcript followed by `checkpointPrompt(...)`, sent with `COMPACT_SYSTEM_PROMPT`. It strips the `<analysis>` notes with `checkpointText`.
2. **Probe.** A fresh model gets the checkpoint, the user's messages and the optional tail. It answers the fixture's questions.
3. **Judge.** A grader scores the answers against the key:
   - recall out of 24 (Q1–Q12);
   - for Q13: next action, plan completeness and redo risk.

Every model call goes through `claude -p` with tools disabled.

```sh
npx tsx scripts/eval-compaction.mjs /path/to/fixture --runs 3 --model opus
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--runs` | 3 | Runs per fixture |
| `--model` | opus | Summarizer model |
| `--probe-model` | sonnet | Model that answers the questions |
| `--judge-model` | opus | Grader model |
| `--max-output-tokens` | 16384 | Sets `{WORDS}` |
| `--out` | `<fixture>/out-eval` | Where the outputs are written |

The script writes one file per stage of each run and a `table.md`.

## Fixtures are private

A fixture is cut from a real session transcript, so it contains private conversation text. **Fixtures live outside this repository and are never committed.** The pilot fixtures were regenerated into `/tmp/compact-pilot` (segment 1) and `/tmp/compact-pilot/seg2` (segment 2).

A fixture directory holds these files:

| File | Content |
|---|---|
| `conversation.txt` | The compacted part, rendered as labeled lines. Alternatively, `messages.json` holds a `ModelMessage[]` that is rendered with `renderTranscript`. |
| `ledger.txt` | The user's messages, verbatim |
| `questions.md` | The probe questions: Q1–Q12 test recall, Q13 asks for the next action |
| `key.md` | The answer key. Its Q13 entry states the expected next action and what counts as redo. |
| `tail.txt` | Optional verbatim last steps |

## Qualification

Phase 1 of the compaction v2 plan passes when all of these hold:

- the summarizer is an Opus-class model, run 3 times per segment;
- segment 1 mean recall is at least 20/24, the Claude Code baseline;
- the segment 2 mean is reported;
- every run scores next action ≥ 1;
- no run scores redo risk 2.

The same eval is rerun after phase 5.
