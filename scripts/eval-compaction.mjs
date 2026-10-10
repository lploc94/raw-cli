#!/usr/bin/env node
// Recall eval for the checkpoint prompt (docs/compaction-v2-design.md §9). Run with tsx so the TypeScript prompt
// code is imported directly:
//
//   npx tsx scripts/eval-compaction.mjs <fixture-dir> [--runs 3] [--model opus] [--probe-model sonnet]
//     [--judge-model opus] [--max-output-tokens 16384] [--out <dir>]
//
// A fixture directory holds private material and never lives in this repository (evals/compaction/README.md):
//   conversation.txt  the compacted part, already rendered as labeled lines (or messages.json: ModelMessage[])
//   ledger.txt        the user's messages, verbatim
//   questions.md      the probe questions (Q1–Q12 recall, Q13 next action)
//   key.md            the answer key, including what Q13 expects and what counts as redo
//   tail.txt          optional verbatim last steps
// Every model call goes through `claude -p` with no tools, so nothing in the fixture can run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPACT_SYSTEM_PROMPT, checkpointPrompt, checkpointText, checkpointWords, renderTranscript } from "../src/compact.js";

function options(argv) {
  const [fixture, ...rest] = argv;
  if (!fixture || fixture.startsWith("--")) throw new Error("usage: eval-compaction.mjs <fixture-dir> [--runs N] [--model M] [--probe-model M] [--judge-model M] [--max-output-tokens N] [--out DIR]");
  const parsed = { fixture: resolve(fixture), runs: 3, model: "opus", probeModel: "sonnet", judgeModel: "opus", maxOutputTokens: 16384 };
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--runs") parsed.runs = Number(value);
    else if (flag === "--model") parsed.model = value;
    else if (flag === "--probe-model") parsed.probeModel = value;
    else if (flag === "--judge-model") parsed.judgeModel = value;
    else if (flag === "--max-output-tokens") parsed.maxOutputTokens = Number(value);
    else if (flag === "--out") parsed.out = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isSafeInteger(parsed.runs) || parsed.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isSafeInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens < 1) throw new Error("--max-output-tokens must be a positive integer");
  parsed.out ??= join(parsed.fixture, "out-eval");
  return parsed;
}

function claude(model, system, input) {
  const result = spawnSync("claude", ["-p", "--model", model, "--tools", "", "--system-prompt", system,
    "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`claude -p --model ${model} exited ${result.status}: ${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}

function read(directory, name) {
  const path = join(directory, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const opts = options(process.argv.slice(2));
const messages = read(opts.fixture, "messages.json");
const transcript = messages !== undefined ? renderTranscript(JSON.parse(messages)) : read(opts.fixture, "conversation.txt");
const ledger = read(opts.fixture, "ledger.txt");
const questions = read(opts.fixture, "questions.md");
const key = read(opts.fixture, "key.md");
const tail = read(opts.fixture, "tail.txt");
if (transcript === undefined || ledger === undefined || questions === undefined || key === undefined) {
  throw new Error("fixture needs conversation.txt (or messages.json), ledger.txt, questions.md and key.md");
}
mkdirSync(opts.out, { recursive: true });

const rows = [];
for (let run = 1; run <= opts.runs; run++) {
  const name = `run${run}`;
  // The fallback-path request of design §6.3: rendered transcript, then the checkpoint prompt with the no-tools guard.
  const request = `${transcript}\n\n${checkpointPrompt({ words: checkpointWords(opts.maxOutputTokens) })}`;
  writeFileSync(join(opts.out, `${name}.summarize-input.txt`), request);
  const raw = claude(opts.model, COMPACT_SYSTEM_PROMPT, request);
  writeFileSync(join(opts.out, `${name}.summary.raw.txt`), raw);
  const checkpoint = checkpointText(raw);
  writeFileSync(join(opts.out, `${name}.summary.txt`), checkpoint);

  const probe = [
    "[Raw compaction checkpoint #1]", "", "## User messages (verbatim, oldest first)", ledger.trim(), "",
    "## Checkpoint", checkpoint, "",
    ...(tail !== undefined ? ["Most recent steps (verbatim):", tail.trim(), ""] : []),
    "---", questions.trim(),
  ].join("\n");
  writeFileSync(join(opts.out, `${name}.probe-input.txt`), probe);
  const answers = claude(opts.probeModel, "You are a coding agent resuming work after your context was compacted. For this check you have no tools: answer only from the context you were given.", probe);
  writeFileSync(join(opts.out, `${name}.answers.txt`), answers);

  const judgeInput = [
    "You grade how well an agent remembered its work after context compaction. Compare the ANSWERS to the ANSWER KEY.",
    "Score each of Q1–Q12: 2 = all key facts correct, 1 = partly correct or vague, 0 = wrong, missing, or 'unknown'. Wrong facts stated confidently count as 0 and are listed under hallucinations.",
    "For Q13, use what the key says Q13 expects: next_action (2 = the immediate action matches the key, 1 = plausible but indirect, 0 = wrong or contradicts the key), plan_complete (2 = includes every remaining step the key lists, 1 = partial, 0 = no), redo_risk (0 = proposes no redo, 1 = minor re-investigation of something already known, 2 = redoes or recommits completed work as the key defines it).",
    'Reply with only JSON: {"q":[s1,...,s12],"next_action":n,"plan_complete":n,"redo_risk":n,"hallucinations":["..."],"notes":"one sentence"}',
    "", "ANSWER KEY:", key.trim(), "", "ANSWERS:", answers.trim(),
  ].join("\n");
  const verdict = claude(opts.judgeModel, "You are a strict grader. Output JSON only.", judgeInput);
  writeFileSync(join(opts.out, `${name}.grade.json`), verdict);
  const match = /\{[\s\S]*\}/.exec(verdict);
  if (!match) throw new Error(`${name}: the judge returned no JSON`);
  const grade = JSON.parse(match[0]);
  const recall = grade.q.reduce((sum, score) => sum + score, 0);
  rows.push({ run: name, recall, nextAction: grade.next_action, planComplete: grade.plan_complete, redoRisk: grade.redo_risk,
    words: checkpoint.split(/\s+/).filter(Boolean).length, hallucinations: grade.hallucinations?.length ?? 0 });
  process.stderr.write(`${name}: recall ${recall}/24, next_action ${grade.next_action}, redo_risk ${grade.redo_risk}\n`);
}

const mean = rows.reduce((sum, row) => sum + row.recall, 0) / rows.length;
const table = [
  `Fixture: ${opts.fixture}`, `Summarizer: ${opts.model}; probe: ${opts.probeModel}; judge: ${opts.judgeModel}; max_output_tokens ${opts.maxOutputTokens}`, "",
  "| Run | Recall /24 | Next action | Plan complete | Redo risk | Words | Hallucinations |", "|---|---|---|---|---|---|---|",
  ...rows.map((row) => `| ${row.run} | ${row.recall} | ${row.nextAction} | ${row.planComplete} | ${row.redoRisk} | ${row.words} | ${row.hallucinations} |`),
  "", `Mean recall: ${mean.toFixed(1)}/24`,
].join("\n");
writeFileSync(join(opts.out, "table.md"), `${table}\n`);
process.stdout.write(`${table}\n`);
