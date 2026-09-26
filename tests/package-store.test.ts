import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { installPackage, listInstalledPackages, removePackage, resolveInstalledPackage, updatePackage } from "../src/packages/store.js";
import { packPackage } from "../src/packages/archive.js";

function source(body: string) {
  const root = mkdtempSync(join(tmpdir(), "raw-install-source-"));
  mkdirSync(join(root, "skills", "review"), { recursive: true });
  writeFileSync(join(root, "skills", "review", "SKILL.md"), `---\nname: review\ndescription: Review\n---\n${body}`);
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/review", version: "1.0.0",
    description: "Review", files: ["skills/review"], exports: { skills: { review: "skills/review" } } }));
  return root;
}

test("install is idempotent, update swaps one alias atomically and leaves old artifacts intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-test-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, "{}");
  const options = { configPath, dataHome: join(root, "data") };
  const firstSource = source("First body\n");
  const secondSource = source("Second body\n");
  await assert.rejects(installPackage({ ...options, source: firstSource, alias: "failed", faultAt: "after-stage" }), /injected/i);
  assert.equal(listInstalledPackages(options).failed, undefined);
  const first = await installPackage({ ...options, source: firstSource, alias: "review" });
  const again = await installPackage({ ...options, source: firstSource, alias: "review" });
  assert.equal(first.digest, again.digest);
  assert.equal(listInstalledPackages(options).review?.digest, first.digest);
  const original = await resolveInstalledPackage({ ...options, alias: "review" });
  assert.match(readFileSync(join(original.root, "skills", "review", "SKILL.md"), "utf8"), /First body/);
  await assert.rejects(installPackage({ ...options, source: secondSource, alias: "review" }), /collision|update/i);
  await assert.rejects(updatePackage({ ...options, source: secondSource, alias: "review", faultAt: "before-index-commit" }), /injected/i);
  assert.equal(listInstalledPackages(options).review?.digest, first.digest);
  const changed = await updatePackage({ ...options, source: secondSource, alias: "review" });
  assert.notEqual(changed.digest, first.digest);
  assert.match(readFileSync(join(original.root, "skills", "review", "SKILL.md"), "utf8"), /First body/);
  assert.match(readFileSync(join((await resolveInstalledPackage({ ...options, alias: "review" })).root,
    "skills", "review", "SKILL.md"), "utf8"), /Second body/);
  assert.equal(existsSync(join(root, "raw", "sessions.sqlite")), false);
});

test("remove identifies agent dependents and does not erase their config", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-dependents-"));
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ agents: { reviewer: { from: "pkg/review/skills/review" } } }));
  const options = { configPath, dataHome: join(root, "data"), alias: "review" };
  await installPackage({ ...options, source: source("body\n") });
  await assert.rejects(removePackage(options), /reviewer/);
  assert.ok(listInstalledPackages(options).review);
  const unrelatedPrompt = JSON.stringify({ agents: { reviewer: { system_prompt: "pkg/review/skills/review", tools: { use: [] } } } });
  writeFileSync(configPath, unrelatedPrompt);
  await removePackage(options);
  assert.equal(listInstalledPackages(options).review, undefined);
  assert.equal(readFileSync(configPath, "utf8"), unrelatedPrompt);
});

test("update rejects newly required recipient inputs and preserves existing bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-bindings-"));
  const configPath = join(root, "raw.json");
  const config = { models: { m: { provider: "ollama", method: "openai-chat-completions", model_id: "fixture" } },
    agents: { writer: { from: "pkg/kit/agents/writer", model: "m", inputs: { region: "Hanoi" }, overrides: { max_steps: 9 } } } };
  writeFileSync(configPath, JSON.stringify(config));
  const authored = (input: string, label: string) => {
    const path = mkdtempSync(join(tmpdir(), "raw-bound-agent-"));
    mkdirSync(join(path, "agents"));
    writeFileSync(join(path, "agents", "writer.json"), JSON.stringify({ system_prompt: { "$input": input }, label }));
    writeFileSync(join(path, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/writer", version: "1.0.0",
      description: "Writer", files: ["agents/writer.json"], exports: { agents: { writer: "agents/writer.json" } },
      inputs: { type: "object", properties: { [input]: { type: "string" } }, required: [input] } }));
    return path;
  };
  const options = { configPath, dataHome: join(root, "data"), alias: "kit" };
  const first = await installPackage({ ...options, source: authored("region", "first") });
  await assert.rejects(updatePackage({ ...options, source: authored("token", "incompatible") }), /input mismatch.*writer/i);
  assert.equal(listInstalledPackages(options).kit?.digest, first.digest);
  const next = await updatePackage({ ...options, source: authored("region", "second") });
  assert.notEqual(next.digest, first.digest);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), config);
});

test("update checks required inputs of an active standalone variable binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-var-input-"));
  const configPath = join(root, "raw.json"), dataHome = join(root, "data");
  writeFileSync(configPath, JSON.stringify({ agents: { raw: { model: "local", vars: ["host"],
    tools: { use: [] } } }, vars: { host: { from: "pkg/kit/vars/host", inputs: { old: "HOST" } } } }));
  const authored = (input: string) => {
    const source = mkdtempSync(join(tmpdir(), "raw-store-var-source-"));
    mkdirSync(join(source, "vars"));
    writeFileSync(join(source, "vars", "host.json"), JSON.stringify({ description: "Host", access: "read",
      source: { kind: "env", name: { $input: input } } }));
    writeFileSync(join(source, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@test/host",
      version: "1.0.0", description: "Host", files: ["vars/host.json"], exports: { vars: { host: "vars/host.json" } },
      inputs: { type: "object", properties: { [input]: { type: "string", "x-raw-kind": "env-name" } }, required: [input] } }));
    return source;
  };
  const before = await installPackage({ configPath, dataHome, source: authored("old"), alias: "kit" });
  await assert.rejects(updatePackage({ configPath, dataHome, source: authored("new"), alias: "kit" }), /input|new/i);
  assert.equal(listInstalledPackages({ configPath, dataHome }).kit?.digest, before.digest);
});

test("two installer processes preserve both aliases in the atomic index", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-concurrent-"));
  const configPath = join(root, "raw.json"), dataHome = join(root, "data");
  writeFileSync(configPath, "{}");
  const packageSource = source("Shared body\n");
  const run = (alias: string) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
      join(process.cwd(), "tests", "fixtures", "package-install-child.ts"), configPath, dataHome, packageSource, alias],
    { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([run("first"), run("second")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(listInstalledPackages({ configPath, dataHome })).sort(), ["first", "second"]);
});

test("an abandoned package writer lock is recovered without discarding the index", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-stale-lock-"));
  const configPath = join(root, "raw.json"), dataHome = join(root, "data");
  writeFileSync(configPath, "{}");
  const mutex = `${configPath}.packages.lock.json.mutex`;
  writeFileSync(mutex, JSON.stringify({ pid: 999999999, nonce: "dead" }));
  utimesSync(mutex, new Date(2000, 0, 1), new Date(2000, 0, 1));
  await installPackage({ configPath, dataHome, source: source("Recovery\n"), alias: "review" });
  assert.ok(listInstalledPackages({ configPath, dataHome }).review);
  assert.equal(existsSync(mutex), false);
});

test("exact dependencies with one package name at two versions coexist in the artifact store", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-dependencies-"));
  const configPath = join(root, "raw.json"), dataHome = join(root, "data");
  writeFileSync(configPath, "{}");
  const children = [] as Array<{ version: string; digest: string; archive: string }>;
  for (const version of ["1.0.0", "2.0.0"]) {
    const dir = join(root, `child-${version}`);
    mkdirSync(join(dir, "skills", "review"), { recursive: true });
    writeFileSync(join(dir, "skills", "review", "SKILL.md"), `---\nname: review\ndescription: Review\n---\nVersion ${version}\n`);
    writeFileSync(join(dir, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/review", version,
      description: "Review", files: ["skills/review"], exports: { skills: { review: "skills/review" } } }));
    const archive = join(root, `review-${version}.rawpkg`);
    const packed = await packPackage(dir, archive);
    children.push({ version, digest: packed.sha256, archive });
  }
  const parent = join(root, "parent");
  mkdirSync(join(parent, "agents"), { recursive: true }); mkdirSync(join(parent, "deps"));
  writeFileSync(join(parent, "agents", "parent.json"), "{}");
  const dependencies: Record<string, unknown> = {};
  for (const [index, child] of children.entries()) {
    const filename = `deps/review-${index}.rawpkg`;
    writeFileSync(join(parent, filename), readFileSync(child.archive));
    dependencies[`review${index}`] = { name: "@example/review", version: child.version, digest: child.digest, archive: filename };
  }
  writeFileSync(join(parent, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/parent", version: "1.0.0",
    description: "Parent", files: ["agents/parent.json", "deps"], exports: { agents: { parent: "agents/parent.json" } }, dependencies }));
  const installed = await installPackage({ configPath, dataHome, source: parent, alias: "parent" });
  assert.deepEqual(Object.values(installed.dependencies).sort(), children.map((child) => child.digest).sort());
  for (const child of children) assert.ok(existsSync(join(dataHome, "raw", "packages", "sha256", child.digest, "content", "raw-package.json")));
});
