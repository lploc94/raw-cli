# Goal kit (opt-in)

A portable package that implements a small goal runtime with Raw's `Stop` continuation. Raw has no goal feature; this package owns the state, criteria, budget and commands, and the host only makes one more model request when the hook denies a stop.

## What it contains

- `goal` tool: create, get, update, complete, pause, resume, block, abandon, clear and budget.
- `goal` panel: objective, acceptance criteria, evidence, steps and status.
- `goal` hook: `Stop` continues while the goal is active; `SessionStart` pauses an interrupted goal; `UserPromptSubmit` pauses an active goal so a new user message is not consent.
- `goal` skill: the model-facing workflow.
- `coder` agent: coding tools, the goal tool, the hook and the skill.

## Install and bind

```sh
raw package pack examples/packages/goal-kit --out goal-kit.rawpkg
raw package install goal-kit.rawpkg --as goal --config CONFIG
raw agent add goal-coder --from pkg/goal/agents/coder --model LOCAL_MODEL --config CONFIG
raw --config CONFIG --agent goal-coder "Implement and verify the fix"
```

The recipient supplies the model alias. Installing the package does not change the existing default agent.

## State and limits

The package writes one JSON state file outside the repository:

- `RAW_GOAL_STATE_DIR` when set;
- otherwise `%LOCALAPPDATA%\raw-goal` on Windows, or `$XDG_STATE_HOME/raw-goal` (falling back to `~/.local/state/raw-goal`);
- file name `goal-<sha256(workspace)>.json`.

Limits: 64 KiB state file with 56 KiB of content (8 KiB reserved for ownership, usage and lifecycle metadata), 50 criteria, 30 steps, 200-character labels, 300-character evidence, one `in_progress` step. The Stop reason is bounded to 8 KiB, with the objective and first criteria first.

## How continuation works

When a run ends with a final answer, the `Stop` hook reads the state. If the goal is active, under its continuation cap and budget, the hook answers `{"decision":"deny","reason":"..."}`. Raw adds the reason as a `[Raw hook continuation]` message and makes one more request. If the goal is complete, paused, blocked, abandoned or over budget, the hook does not deny and the run ends normally.

The package requires `raw.stop-continue/1` and `raw.hook/2`; a host without that capability rejects the package.

## Limitations

- **One goal per workspace.** Raw package tools do not receive `session_id`, so the tool cannot key its state by session. Sessions and agents that share a workspace share one goal; the `Stop` hook records an owner session and does not continue another session's goal. A new runtime attach pauses an active goal and takes ownership, so a dead owner's goal can be resumed explicitly; two live sessions can still race to claim an unowned goal created in the same run. A separate engine issue proposes exposing `session_id`; per-session state is a follow-up.
- **Soft budget.** The Stop hook checks usage only at a final answer, not before every model request. A single run can overshoot a token or request threshold. Usage is counted for the whole owning session, from its start: the tool cannot see usage when it creates the goal, so a goal created late in a long session may pause on its first final answer with `token_budget_exhausted` or `request_budget_exhausted`; raise the budget with `goal budget` and resume. A session that takes the goal over counts from its own start, what earlier owners spent is kept, and a session that returns continues from where it stopped. Only the last 16 owners are remembered: a session that returns after 16 other owners have held the goal is counted from zero again, which overcounts (never undercounts) and can pause the goal early; raise the budget and resume.
- **No live pause/cancel.** Use the `goal pause` tool or the panel's Pause action. Ctrl-C cancels the run and the hook pauses the goal, but there is no host-level pause command.
- **Lifecycle actions are model-facing.** The `goal` skill tells the model to pause before asking and not to resume without the user, but a package tool cannot prove whether a call came from a person or the model. Tool policy and approvals still apply; do not treat a model-initiated resume as human consent.
- **No dashboard native controls or CLI `/goal` command.** The `goal` skill is offered by the composer as a prompt; it is not a host command.
- **Restart is explicit.** `SessionStart` pauses an active goal; resume it explicitly before expecting more work.
- **Corrupt state fails open.** Hooks ignore a corrupt state file; the tool reports `state_corrupt` and you must delete the state file manually before creating a new goal.
- Evidence is a recorded claim, not independent proof that a command ran. Existing tool policy and approvals are unchanged.

## Tests

The package is covered by `tests/goal-kit-package.test.ts`, `tests/goal-kit-hooks.test.ts` and `tests/goal-kit-cli.test.ts`. Integration packs the package, removes the author source, installs it into a recipient config, runs the real CLI against the fake provider, and checks restart behavior.
