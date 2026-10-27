---
name: goal
description: Create, track and close one verifiable goal with acceptance criteria and evidence, using the goal tool and the package's Stop continuation.
---

# Working with a goal

A goal is what the user wants plus how they will judge it done. Criteria are the definition of done; steps are only the order of the work.

## Start

Call the `goal` tool with `action: "create"`, a short objective, a `doneWhen` a stranger could check, and at least one required criterion. Write criteria as statements that are either met or not ("`npm run typecheck` exits 0"), never as activities ("work on types").

## Progress

Call `goal update` with the `id` from the last result. Put the proof in `evidence`: the command and what it printed. A criterion becomes `done` when its evidence exists. Use `blocked` with evidence when something outside your control stops it. Keep at most one step `in_progress`.

## Stop and ask

The Stop hook continues the run while the goal is active. If you need the user's input, call `goal pause` with a reason first; then ask. Do not rely on a final answer to stop the loop.

## Close

Call `goal complete` only when every required criterion is `done` and has evidence. Call `goal abandon` when the user stops the work. Use `goal budget` only when the user asks to change a limit.

## Limits

One goal per workspace. State lives in the package's state store, not in the repository. The budget is checked at final answers, not before every request. See the package README for the state path and limitations.
