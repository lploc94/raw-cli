# Raw skill authoring cheatsheet

Updated 2026-09-26. This guide describes the authoring approach used by Raw's five English setup skills.

## What makes a skill useful

A skill supplies knowledge and procedures the model would otherwise get wrong. Start with actual tasks, corrections, and failure traces. Keep one coherent purpose, choose a default approach, and make unusual project constraints explicit. Length is not a proxy for usefulness. [Agent Skills: best practices](https://agentskills.io/skill-creation/best-practices)

There is no universal set of required body headings. Use enough structure to make the decisions easy to find. For Raw's setup skills, the following parts address the observed failures:

| Part | What to write | Raw example |
| --- | --- | --- |
| Selection description | User intent, applicability, useful boundary | Configure existing Raw settings; distinguish from creating a new callable tool |
| Purpose and routing | Outcome and explanation/change/diagnosis branches | A how-to question receives guidance; it does not automatically start editing config |
| Inputs and prerequisites | Required inputs, defaults, dependencies, questions only for missing blockers | Explicit agent, otherwise effective selection; installed MCP command or known remote URL |
| Procedure | Ordered actions and conditional decisions | Inspect relevant settings safely, make the requested change, validate it |
| Contract and example | Exact field types, supported values, locations, realistic example | `agents.<name>.model` references `models.<alias>`; show where a fragment belongs |
| Verification and recovery | What proves success, what each check cannot prove, likely failures | Config parsing does not prove an MCP connection works |
| Completion report | Deliverable, validation evidence, unresolved dependency | Files changed, selected agent/tool, check run, any unverified live behavior |

Combine short parts rather than filling a rigid template. Branch before the action list so an informational request does not inherit mutation steps. Use examples and validation loops for error-prone work; allow judgment where several implementations are reasonable. [Claude: skill authoring](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

## Write the selection description first

The description should let an agent distinguish neighboring skills. Mention what the user wants and when this skill helps; internal file formats alone are weak selection hints. Test both likely requests and near misses. For example, writing an ordinary Markdown checklist should not automatically become installing a Raw skill. [Agent Skills: descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)

For this kit, prefer bounded descriptions over deliberately broad triggering. Raw has only five setup skills and should not load them during unrelated coding work. This is a Raw design choice, not a universal specification rule.

## Adapt the format to Raw

Raw currently has its own strict manifest contract; it does not parse Agent Skills YAML frontmatter as registration metadata. The shared Agent Skills specification describes a different metadata convention and optional supporting directories. Borrow its authoring principles without claiming format compatibility. [Agent Skills specification](https://agentskills.io/specification)

```text
skills/my_skill/
  skill.json
  SKILL.md
```

`skill.json` has exactly `api_version` (number `1`), `id` (folder ID), `version` (three numeric semver components), `name` (unique selected model-visible skill name), and `description` (nonempty string). `id` follows `[a-z][a-z0-9_-]*`; `name` follows `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Register an exact `local/<id>` or `agent/<id>` in `skills.use`; select both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. The shipped `create_skill` instructions provide a complete creation and registration example.

Raw exposes names/descriptions only after `list_skills`; `load_skill` returns the complete selected Markdown at the conversation tail. The loader validates the body against `max_output_bytes` (default **8192 bytes**, not tokens). The catalog must also fit. No arbitrary minimum word/byte count establishes quality.

Keep the five shipped bodies self-contained within that cap. Today's copy script packages only `skill.json` and `SKILL.md`, and the load result provides no resource base path. Do not rely on `references/`, helper scripts, a source checkout, or relative `docs/...` links as mandatory runtime dependencies. Supporting-resource delivery would be a separate runtime design. The common recommendation to split long skills into references therefore needs adaptation for Raw, rather than literal adoption.

## A body outline to adapt

```markdown
# <Task and outcome>

Use for <specific intent>. For <nearby intent>, use <appropriate route>.

## Choose the path
- Explain: answer from the contract and example; inspect only if needed.
- Change: carry out the user's requested work with the procedure below.
- Diagnose: start from the reported error and inspect its relevant inputs.

## Inputs and contract
<Required information, safe defaults, paths, field types, constraints.>

## Procedure
1. Establish the target from supplied information.
2. Perform the smallest complete requested operation.
3. Validate the relevant result; fix the actual failure.

## Example
<Runnable example or clearly labeled fragment with its insertion location.>

## Verification and common failures
<Observable success, boundary cases, recovery, stopping conditions.>

## Report
<Outcome, checks actually performed, remaining uncertainty.>
```

This is a writing aid, not a parser schema or a mandatory list of headings. A created skill about release notes need not inherit Raw configuration procedures.

## Dynamic data

Teach skills to discover/read selected vars on demand or pass references to consuming tools. Do not capture current time, location, credentials or provider output in static skill text. configure_raw covers variable declarations; create_tool covers executable provider scripts; create_agent covers portable selections. MCP values remain literal.

## Rules specific to the setup kit

- **Match the procedure to the request.** For generic how-to questions, the loaded instructions should be sufficient. Avoid making repository inspection or a demo server a mandatory prerequisite to explaining a field.
- **Respect the requested edit.** Preserve unrelated agents, defaults, selected tools/skills and ordering. Reuse authorization already given; ask only for missing choices that prevent a correct edit.
- **Make examples honest.** Label placeholders and fragments. Do not invent available model IDs, context capacities, MCP tool names, environment interpolation, or CLI flags.
- **Distinguish verification levels.** `raw config list` validates configuration structure. Loading a prompt/plugin and calling a selected MCP tool require their own checks. In particular, `sessions` is canonical-only: validating a copied canonical config as an arbitrary alternate file will fail. Stage such a candidate as `raw/config.json` under a temporary `XDG_CONFIG_HOME`, preserving its `sessions` data; static config validation does not require copying prompt/tool/skill folders.
- **Stop when the request is answered.** Smoke tests are conditional on the requested change. Do not start a recursive model task solely to prove a prose explanation.

These rules are grounded in Raw's contracts and setup sessions. The target is correct, useful instructions. Model-dependent extra actions and config reads are diagnostic observations, not behavior enforced by this skill kit.

## Evaluate discovery and execution separately

Create a small set of realistic prompts with expected outcomes and fixture inputs. Compare the current and revised skill with the same model/settings. Grade observable artifacts and full tool traces, not only a polished final answer. Start small, include boundary cases, and expand around actual failures. [Agent Skills: evaluating output](https://agentskills.io/skill-creation/evaluating-skills)

For each of the five setup skills, include a how-to request and an execution request. Add near misses to check over-selection. Record:

- Whether the appropriate skill was listed/loaded and whether unrelated skills stayed unloaded.
- Whether examples parse/load/execute under Raw's real contracts.
- Whether the requested files/settings changed while unrelated data survived.
- Whether validation claims match checks actually run.
- Tool calls, requests, context/usage when available, and unnecessary work.

Use deterministic tests for schemas, manifests, artifact behavior and packaging. Use real-model runs and human inspection for selection, instruction-following and response quality. Scripted mock-provider calls test wiring; they cannot prove that a model understood the skill. Avoid exact-sentence assertions and word-count gates. A bounded evaluation is diagnostic evidence for those cases/model settings, not a guarantee of every model action. Correct schemas, runnable examples and accurate instructions are this kit's acceptance criteria; model-dependent extra work is not a release gate.

## Pre-ship checklist

- Description selects the right task and excludes realistic near misses.
- Shipped skill bodies, descriptions and worked skill templates use English.
- Body supplies Raw-specific knowledge and a clear next action.
- How-to, change and diagnosis paths do only their relevant work.
- Examples have exact insertion locations and pass real contract checks.
- Required information is available from the installed package.
- Body and catalog fit the actual byte cap.
- Source and generated examples match; packed consumers load all five bodies.
- Evaluation report contains failures and limitations as well as successes.
