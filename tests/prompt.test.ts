import test from "node:test";
import assert from "node:assert/strict";
import { getEncoding } from "js-tiktoken";
import { DEFAULT_SYSTEM_PROMPT, resolveSystemPrompt } from "../src/llm/prompt.js";

test("T-01c: exact default system prompt fits reference 50-token budget", () => {
  assert.equal(DEFAULT_SYSTEM_PROMPT, "You are a terminal coding assistant. Use available tools directly to inspect files, make requested changes, and verify results. Continue until the task is complete or blocked. Report the outcome and any remaining problems clearly.");
  const tokens = getEncoding("o200k_base").encode(DEFAULT_SYSTEM_PROMPT).length;
  assert.ok(tokens <= 50, `Default prompt uses ${tokens} reference tokens`);
});

test("T-01c: flag, environment and empty overrides stay literal", () => {
  assert.equal(resolveSystemPrompt(undefined, undefined), DEFAULT_SYSTEM_PROMPT);
  assert.equal(resolveSystemPrompt(undefined, "environment"), "environment");
  assert.equal(resolveSystemPrompt("flag", "environment"), "flag");
  assert.equal(resolveSystemPrompt("", "environment"), "");
  assert.equal(resolveSystemPrompt(undefined, ""), "");
});
