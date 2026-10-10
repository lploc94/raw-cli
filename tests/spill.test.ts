import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { capResult } from "../src/tools/results.js";
import { savedLabel, setSpillTotalBytesForTests, spillFits, SPILL_MAX_BYTES, SPILL_TOTAL_BYTES, spillText } from "../src/tools/spill.js";

test("saved outputs stay within the aggregate bound by deleting the oldest copies", () => {
  setSpillTotalBytesForTests(2500);
  try {
    const first = spillText("t", "a".repeat(1000)).path!;
    const second = spillText("t", "b".repeat(1000)).path!;
    const third = spillText("t", "c".repeat(1000)).path!;
    assert.equal(existsSync(first), false);
    assert.equal(readFileSync(second, "utf8"), "b".repeat(1000));
    assert.equal(readFileSync(third, "utf8"), "c".repeat(1000));
  } finally { setSpillTotalBytesForTests(SPILL_TOTAL_BYTES); }
});

test("a copy fits only when it is saved whole without deleting another saved copy", () => {
  setSpillTotalBytesForTests(1000);
  try {
    const kept = spillText("t", "k".repeat(1000)).path!;
    assert.equal(spillFits(1), false, "the aggregate is full");
    setSpillTotalBytesForTests(1500);
    assert.equal(spillFits(500), true);
    assert.equal(spillFits(501), false);
    setSpillTotalBytesForTests(SPILL_TOTAL_BYTES);
    assert.equal(spillFits(SPILL_MAX_BYTES), true);
    assert.equal(spillFits(SPILL_MAX_BYTES + 1), false, "a larger copy would be capped");
    assert.equal(readFileSync(kept, "utf8"), "k".repeat(1000), "checking deletes nothing");
  } finally { setSpillTotalBytesForTests(SPILL_TOTAL_BYTES); }
});

test("a copy that holds only the start of the output says so wherever it is named", () => {
  assert.equal(savedLabel("/tmp/x.log"), "/tmp/x.log");
  assert.equal(savedLabel("/tmp/x.log", true), `/tmp/x.log (first ${SPILL_MAX_BYTES} bytes only)`);
  const capped = capResult({ isError: false, content: [{ type: "text", text: "x".repeat(5000) }], fullOutputPath: "/tmp/saved.log", fullOutputCapped: true }, 1024);
  assert.match(JSON.stringify(capped.content), /Full output saved to \/tmp\/saved\.log \(first \d+ bytes\)/);
  assert.equal(capped.fullOutputCapped, true);
});
