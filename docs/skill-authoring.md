# Raw skill authoring cheatsheet

Updated 2026-09-26. This guide describes the authoring approach used by Raw's seven English setup skills.

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

For this kit, prefer bounded descriptions over deliberately broad triggering. Raw has seven setup skills and should not load them during unrelated coding work. This is a Raw design choice, not a universal specification rule.

## Adapt the format to Raw

Raw uses Agent Skills YAML frontmatter for skill name and description. The directory may contain `scripts/`, `references/` and `assets/`; portable packages include declared owned files. [Agent Skills specification](https://agentskills.io/specification)

```text
skills/my-skill/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` starts with `---`, a lowercase kebab-case `name` matching the folder, a nonempty `description` (at most 1024 characters), and a closing `---`. Optional standard frontmatter fields include `license`, `compatibility` and string-valued `metadata`. Register exact `local/<id>` or `agent/<id>` in `skills.use`; select both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. The shipped `create_skill` instructions provide a complete example.

For sharing, place the skill directory in a package's declared `files` and `exports.skills`, validate the source with `raw package validate DIR`, then pack it with `raw package pack DIR --out FILE.rawpkg`. A recipient installs the artifact under an alias and selects `pkg/ALIAS/skills/EXPORT`, optionally using `{"ref":"...","as":"visible-name"}` when another selected skill already uses the same name. The folder/frontmatter name remains the underlying skill identity; the local `as` name is what `load_skill` receives. Editing a linked source takes effect on the next runtime snapshot. An existing session resumes with the current selection and appends a reload notice if earlier skill information became stale; adding a skill does not prepend its Markdown to the cached request prefix.

Raw exposes names/descriptions only after `list_skills`; `load_skill` returns the body after frontmatter at the conversation tail. The body and catalog arrive whole regardless of the agent's `max_output_bytes`; only a body over 1 MiB is skipped, with a startup warning. No arbitrary minimum word/byte count establishes quality.

Keep the seven shipped bodies self-contained within that cap. The copy script preserves entire skill folders, including references, scripts and assets. A `load_skill` result contains the body, not automatic resource contents; mention relative resources in instructions and use the agent's file tools to read them when needed. Do not rely on a source checkout or undeclared files for portable packages.

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

Distinguish source package definitions from recipient bindings. The package carries declared file closures and typed input sites; the recipient supplies local model aliases, environment names, paths and endpoints. A source change can rotate a generated cache key once, but an unchanged subsequent resume of the same session is stable. Do not instruct users to clear or migrate their sessions merely because a skill, tool, agent or package changed. `package link` is an authoring snapshot, `package fork` produces editable source, and `package update` changes one installed alias after checking current bindings.

## Rules specific to the setup kit

- **Match the procedure to the request.** For generic how-to questions, the loaded instructions should be sufficient. Avoid making repository inspection or a demo server a mandatory prerequisite to explaining a field.
- **Respect the requested edit.** Preserve unrelated agents, defaults, selected tools/skills and ordering. Reuse authorization already given; ask only for missing choices that prevent a correct edit.
- **Make examples honest.** Label placeholders and fragments. Do not invent available model IDs, context capacities, MCP tool names, environment interpolation, or CLI flags.
- **Distinguish verification levels.** `raw config list` validates configuration structure. Loading a prompt/plugin and calling a selected MCP tool require their own checks. In particular, `sessions` is canonical-only: validating a copied canonical config as an arbitrary alternate file will fail. Stage such a candidate as `raw/config.json` under a temporary `XDG_CONFIG_HOME`, preserving its `sessions` data; static config validation does not require copying prompt/tool/skill folders.
- **Stop when the request is answered.** Smoke tests are conditional on the requested change. Do not start a recursive model task solely to prove a prose explanation.

These rules are grounded in Raw's contracts and setup sessions. The target is correct, useful instructions. Model-dependent extra actions and config reads are diagnostic observations, not behavior enforced by this skill kit.

## Evaluate discovery and execution separately

Create a small set of realistic prompts with expected outcomes and fixture inputs. Compare the current and revised skill with the same model/settings. Grade observable artifacts and full tool traces, not only a polished final answer. Start small, include boundary cases, and expand around actual failures. [Agent Skills: evaluating output](https://agentskills.io/skill-creation/evaluating-skills)

For each setup skill, include a how-to request and an execution request. Add near misses to check over-selection. Record:

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
- Source and generated examples match; packed consumers load all seven bodies and their linked references are available.
- Evaluation report contains failures and limitations as well as successes.

## Browser authoring

`raw dashboard` offers **Library → Skills** for creating from a shipped example,
forking builtins/immutable exports, and editing `SKILL.md` or contained text
resources. Each file saves independently with a revision check. Attach the saved
skill to a direct agent explicitly; package-agent selection overrides are complete
replacements in Agent JSON.

Browsing a catalog or Markdown preview is static inspection. Verification still
requires selecting/listing/loading the skill through its ordinary tools when the
request calls for it. Save applies on the next turn and preserves the conversation
ID; opening the editor never injects its source into model context. Browser guidance
belongs in optional references when it would crowd a concise main skill body.
