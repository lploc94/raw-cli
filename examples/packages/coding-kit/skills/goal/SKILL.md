---
name: goal
description: Use when a task has a completion condition worth tracking. Sets one goal with checkable acceptance criteria, keeps it current with evidence, and refuses to call it achieved without proof.
---

# Working with a goal

A goal is what the user wants plus how they will judge it done. It is not a todo list: criteria are the definition of
done, steps are only the order of the work.

## When to set one

Set a goal when the request has a completion condition you can check **and** needs three or more steps. Skip it for a
single trivial step, a question, or a pure explanation. One goal per session: if the work changes shape, update it
instead of starting a second one.

## The four moves

1. **Set it before starting.** `goal` with `mode: "set"`, one sentence of `goal`, a `done_when` a stranger could check,
   and the criteria you will verify. Write criteria as statements that are either met or not ("`npm run typecheck`
   exits 0"), never as activities ("work on types").
2. **Update it with evidence.** `mode: "update"` with the item `id` from the last result. Put the proof in `note`, for
   example the command and what it printed. A criterion becomes `done` when its evidence exists, not when the code
   looks right. Use `blocked` with a note when something outside your control stops it.
3. **Continue from the list.** Work the open criteria in order, and keep at most one step `in_progress`. If the user
   asks where things stand, answer from the panel: what is met, what is open, and what you need next.
4. **Close it honestly.** `outcome: "achieved"` only when every criterion is met and you have run its check. Use
   `outcome: "abandoned"` when the user stops the work. Never mark achieved to make the panel look finished.

## Limits worth knowing

- The state lives in this session's panel. It survives a restart and a compaction, but a new chat starts with no goal.
- Nothing continues the work automatically: the user presses **Continue** on the panel or sends the next message.
- Keep criteria under 50 and steps under 30, and keep each label short enough to read in a sidebar.
