import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forkPackage, linkPackage, resolveInstalledPackage } from "../src/packages/store.js";

test("linked source changes only the next immutable snapshot and fork is independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-link-test-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, "{}");
  const linked = join(root, "linked");
  mkdirSync(join(linked, "tools", "helper"), { recursive: true });
  writeFileSync(join(linked, "tools", "helper", "tool.json"), JSON.stringify({ api_version: 1, id: "helper", version: "1.0.0",
    name: "helper", description: "Helper", input_schema: { type: "object" }, entry: "./index.mjs" }));
  writeFileSync(join(linked, "tools", "helper", "index.mjs"), 'import { value } from "./helper.mjs"; export async function handler() { return value; }');
  const helper = join(linked, "tools", "helper", "helper.mjs");
  writeFileSync(helper, 'export const value = "old";');
  writeFileSync(join(linked, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/helper", version: "1.0.0",
    description: "Helper", files: ["tools/helper"], exports: { tools: { helper: "tools/helper" } } }));
  const options = { configPath, dataHome: join(root, "data"), alias: "helper" };
  await linkPackage({ ...options, source: linked });
  const old = await resolveInstalledPackage(options);
  writeFileSync(helper, 'export const value = "new";');
  assert.match(readFileSync(join(old.root, "tools", "helper", "helper.mjs"), "utf8"), /old/);
  const oldModule = await import(join(old.root, "tools", "helper", "index.mjs"));
  assert.equal(await oldModule.handler(), "old");
  const next = await resolveInstalledPackage(options);
  assert.notEqual(next.digest, old.digest);
  const newModule = await import(join(next.root, "tools", "helper", "index.mjs"));
  assert.equal(await newModule.handler(), "new");
  const fork = join(root, "fork");
  await forkPackage({ ...options, out: fork });
  assert.ok(existsSync(join(fork, "raw-package.json")));
  writeFileSync(join(fork, "tools", "helper", "helper.mjs"), 'export const value = "fork";');
  assert.match(readFileSync(join(next.root, "tools", "helper", "helper.mjs"), "utf8"), /new/);
});
