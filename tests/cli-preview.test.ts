import assert from "node:assert/strict";
import { test } from "node:test";
import { resultPreview } from "../src/cli.js";

test("MCP JSON results arrays remain generic and do not throw on null rows", () => {
  for (const value of [
    { results: [null] },
    { results: [{ title: "hit" }], total: 12 },
  ]) {
    const preview = resultPreview("mcp_search", { isError: false, content: [{ type: "json", value }] });
    assert.equal(preview, JSON.stringify(value));
  }
});

test("only valid built-in batch rows get indexed status summaries", () => {
  const valid = { results: [{ index: 0, status: "ok", stdout: "x" }, { index: 1, status: "error", error: "nope" }] };
  assert.match(resultPreview("bash", { isError: true, content: [{ type: "json", value: valid }] }),
    /^statuses: 0:ok 1:error\n/);
  const malformed = { results: [null] };
  assert.equal(resultPreview("bash", { isError: false, content: [{ type: "json", value: malformed }] }),
    JSON.stringify(malformed));
});
