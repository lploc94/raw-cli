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

test("base export categories validate and release labels do not change component references", () => {
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

test("an exact dependency archive with the wrong digest cannot validate", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-dependency-"));
  mkdirSync(join(root, "deps")); mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "deps", "other.rawpkg"), "archive bytes");
  writeFileSync(join(root, "agents", "root.json"), "{}");
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/root", version: "1.0.0",
    description: "Root", files: ["deps/other.rawpkg", "agents/root.json"], exports: { agents: { root: "agents/root.json" } },
    dependencies: { other: { name: "@example/other", version: "1.0.0", digest: "0".repeat(64), archive: "deps/other.rawpkg" } } }));
  await assert.rejects(loadPackageManifest(root), /dependency archive digest mismatch/);
});

test("a statically imported tool helper must be covered by the declared file graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-helper-"));
  mkdirSync(join(root, "tools", "helper"), { recursive: true });
  writeFileSync(join(root, "tools", "helper", "tool.json"), "{}");
  writeFileSync(join(root, "tools", "helper", "index.mjs"), 'import "./helper.mjs";');
  writeFileSync(join(root, "tools", "helper", "helper.mjs"), "export const value = 1;");
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/helper", version: "1.0.0",
    description: "Helper", files: ["tools/helper/tool.json", "tools/helper/index.mjs"],
    exports: { tools: { helper: "tools/helper" } } }));
  await assert.rejects(loadPackageManifest(root), /undeclared package helper or asset.*helper\.mjs/);
});

test("exported agent references must resolve inside the package or a declared dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-refs-"));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "a.json"), JSON.stringify({ tools: { use: ["#tools/missing"] } }));
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/refs", version: "1.0.0",
    description: "Refs", files: ["agents/a.json"], exports: { agents: { a: "agents/a.json" } } }));
  await assert.rejects(loadPackageManifest(root), /unresolved package reference.*tools\/missing/);
});

test("hook exports validate declared assets passively and reject escaping paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-package-hook-manifest-"));
  mkdirSync(join(root, "hooks", "guard"), { recursive: true });
  const manifest = { schema_version: 1, name: "@example/guard", version: "1.0.0",
    description: "Guard", files: ["hooks/guard"], exports: { hooks: { guard: "hooks/guard" } }, requires: ["raw.hook/1"] };
  const hook = { name: "guard", events: [{ name: "PreToolUse", match: "builtin/bash" }], command: "node", args: ["./index.mjs"] };
  writeFileSync(join(root, "raw-package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "hooks", "guard", "hook.json"), JSON.stringify(hook));
  writeFileSync(join(root, "hooks", "guard", "index.mjs"), "throw new Error('must not execute during inspection');");
  assert.equal((await loadPackageManifest(root)).manifest.exports.hooks?.guard, "hooks/guard");
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ ...manifest, files: ["hooks/guard/hook.json"] }));
  await assert.rejects(loadPackageManifest(root), /undeclared hook asset/);
  writeFileSync(join(root, "raw-package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "hooks", "guard", "hook.json"), JSON.stringify({ ...hook, args: ["./../escape.mjs"] }));
  await assert.rejects(loadPackageManifest(root), /invalid exported hook|undeclared hook asset|escape/);
  writeFileSync(join(root, "hooks", "guard", "hook.json"), JSON.stringify(hook));
  symlinkSync(join(root, "hooks", "guard", "index.mjs"), join(root, "hooks", "guard", "link.mjs"));
  await assert.rejects(loadPackageManifest(root), /symlink/);
});
