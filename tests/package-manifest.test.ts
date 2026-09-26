import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPackageManifest, parsePackageManifest } from "../src/packages/manifest.js";

const complete = {
  schema_version: 1, name: "@example/kit", version: "1.2.3", description: "Reusable kit",
  files: ["agents/agent.json", "skills/review", "tools/search", "vars/location.json", "var_providers/time.json", "mcp/search.json"],
  exports: { agents: { agent: "agents/agent.json" }, skills: { review: "skills/review" },
    tools: { search: "tools/search" }, vars: { location: "vars/location.json" },
    var_providers: { time: "var_providers/time.json" }, mcp: { search: "mcp/search.json" } },
  inputs: { type: "object", properties: { region: { type: "string", default: "Hanoi" } }, required: [] },
  requires: ["raw.tool-api/1"], dependencies: {},
};

test("six export categories validate and release labels do not change component references", () => {
  const first = parsePackageManifest(JSON.stringify(complete));
  const second = parsePackageManifest(JSON.stringify({ ...complete, version: "2.0.0" }));
  assert.deepEqual(first.exports, second.exports);
  assert.equal(first.version, "1.2.3");
  assert.equal(second.version, "2.0.0");
});

test("manifest rejects duplicate keys, empty exports, invalid SemVer and escape paths", () => {
  assert.throws(() => parsePackageManifest('{"schema_version":1,"schema_version":1}'), /duplicate/i);
  for (const changed of [
    { ...complete, version: "1.2" },
    { ...complete, exports: {} },
    { ...complete, files: ["../outside"] },
    { ...complete, exports: { ...complete.exports, agents: { agent: "/absolute" } } },
  ]) assert.throws(() => parsePackageManifest(JSON.stringify(changed)), /invalid|export|path|version/i);
});

test("data-only package validation checks owned closure and rejects links", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-manifest-"));
  for (const part of ["agents", "skills/review", "tools/search", "vars", "var_providers", "mcp"]) mkdirSync(join(root, part), { recursive: true });
  for (const file of ["agents/agent.json", "skills/review/SKILL.md", "tools/search/tool.json", "tools/search/index.mjs",
    "vars/location.json", "var_providers/time.json", "mcp/search.json"]) {
    writeFileSync(join(root, file), file.endsWith("index.mjs") ? 'throw new Error("executed unexpectedly");' : "{}");
  }
  writeFileSync(join(root, "raw-package.json"), JSON.stringify(complete));
  const loaded = await loadPackageManifest(root);
  assert.ok(loaded.files.includes("tools/search/index.mjs"));
  assert.equal(loaded.manifest.name, "@example/kit");
  symlinkSync(join(root, "agents/agent.json"), join(root, "skills/review/linked.json"));
  await assert.rejects(loadPackageManifest(root), /link|symlink/i);
});
