import assert from "node:assert/strict";
import { test } from "node:test";
import { countOverhead } from "../scripts/overhead.mjs";

test("production prompt and built-in definitions fit reference budget", () => {
  const report = countOverhead();
  assert.equal(report.definitions.length, 3);
  assert.ok(report.promptTokens <= 50);
  assert.ok(report.combinedTokens <= 500);
  assert.equal(JSON.parse(report.canonical).tools.length, 3);
});
