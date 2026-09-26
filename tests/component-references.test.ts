import assert from "node:assert/strict";
import { test } from "node:test";
import { parseComponentReference, parseSelectionReference } from "../src/packages/references.js";
import { applyPackageInputs, parseInputSchema } from "../src/packages/inputs.js";
import { resolveComponent, assertDependencyGraph, fingerprintComponent } from "../src/packages/components.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackageManifest } from "../src/packages/manifest.js";

test("package references retain stable owner, kind and export separately from aliases", () => {
  assert.deepEqual(parseComponentReference("#tools/search"), { source: "self", kind: "tools", exportName: "search" });
  assert.deepEqual(parseComponentReference("dep:geo#vars/location"),
    { source: "dependency", dependency: "geo", kind: "vars", exportName: "location" });
  assert.deepEqual(parseComponentReference("pkg/kit/skills/review"),
    { source: "installed", alias: "kit", kind: "skills", exportName: "review" });
  assert.deepEqual(parseSelectionReference({ ref: "pkg/kit/tools/search", as: "web_search" }),
    { ref: "pkg/kit/tools/search", as: "web_search", inputs: {} });
  assert.throws(() => parseComponentReference("pkg/../tools/search"), /reference|invalid/i);
  assert.throws(() => parseSelectionReference({ ref: "#tools/search", as: "bad/name" }), /alias|invalid/i);
});

test("component resolution is data-only, scoped and independent of release labels", async () => {
  const make = async (version: string) => {
    const root = mkdtempSync(join(tmpdir(), "raw-component-"));
    mkdirSync(join(root, "tools", "search"), { recursive: true });
    writeFileSync(join(root, "tools", "search", "tool.json"), JSON.stringify({ api_version: 1, id: "search",
      version, name: "search", description: "Search", input_schema: { type: "object" }, entry: "./index.mjs" }));
    writeFileSync(join(root, "tools", "search", "index.mjs"), 'throw new Error("tool imported during component resolution");');
    writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/kit", version,
      description: "Kit", files: ["tools/search"], exports: { tools: { search: "tools/search" } }, requires: ["raw.tool-api/1"] }));
    return loadPackageManifest(root);
  };
  const first = await make("1.0.0");
  const second = await make("2.0.0");
  const resolved = resolveComponent("#tools/search", { self: first });
  assert.equal(resolved.canonicalIdentity, "@example/kit#tools/search");
  assert.equal(await fingerprintComponent(first, "tools", "search"), await fingerprintComponent(second, "tools", "search"));
  assert.throws(() => resolveComponent("#skills/missing", { self: first }), /skills\/missing/);
  assert.throws(() => resolveComponent("dep:geo#tools/search", { self: first }), /geo/);
  assert.throws(() => resolveComponent("#tools/search", { self: first, hostCapabilities: new Set() }), /raw.tool-api\/1/);
});

test("dependency graph rejects cycles without importing components", () => {
  const manifest = (name: string, dependencies: Record<string, string>) => ({ name, dependencies });
  assert.throws(() => assertDependencyGraph(new Map([
    ["a", manifest("@x/a", { b: "b" })], ["b", manifest("@x/b", { a: "a" })],
  ])), /cycle/i);
});

test("typed input defaults, required fields and whole-value references are bounded", () => {
  const schema = parseInputSchema({ type: "object", required: ["token_env"], properties: {
    token_env: { type: "string", "x-raw-kind": "env-name" },
    city: { type: "string", default: "Hanoi" },
  } });
  assert.deepEqual(applyPackageInputs({ command: { "$input": "city" } }, schema,
    { token_env: "WEATHER_KEY" }, ["command"]), { command: "Hanoi" });
  assert.throws(() => applyPackageInputs({ command: { "$input": "city" } }, schema, {}, ["command"]), /token_env/);
  assert.throws(() => applyPackageInputs({ command: "${city}" }, schema,
    { token_env: "WEATHER_KEY" }, ["command"]), /interpolation|template/i);
  assert.throws(() => applyPackageInputs({ markdown: { "$input": "city" } }, schema,
    { token_env: "WEATHER_KEY" }, ["command"]), /markdown|site/i);
  assert.throws(() => parseInputSchema({ type: "object", properties: {}, if: {} }), /unsupported|condition/i);
});

test("file inputs bind to the recipient config directory and never the publisher directory", () => {
  const schema = parseInputSchema({ type: "object", properties: { data: { type: "string", "x-raw-kind": "file" } }, required: ["data"] });
  assert.deepEqual(applyPackageInputs({ path: { "$input": "data" } }, schema, { data: "assets/data.json" },
    ["path"], "/recipient/config"), { path: "/recipient/config/assets/data.json" });
  assert.throws(() => applyPackageInputs({ path: { "$input": "data" } }, schema, { data: "assets/data.json" }, ["path"]),
    /recipient config directory/);
});
