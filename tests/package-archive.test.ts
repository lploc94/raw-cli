import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { packPackage, validatePackageArchive, unpackPackage } from "../src/packages/archive.js";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

test("identical package bytes produce identical archives across source mtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-pack-source-"));
  mkdirSync(join(root, "skills", "review"), { recursive: true });
  const skill = join(root, "skills", "review", "SKILL.md");
  writeFileSync(skill, "---\nname: review\ndescription: Review\n---\n# Review\nRead the code.\n");
  chmodSync(skill, 0o755);
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/review", version: "1.0.0",
    description: "Review", files: ["skills/review"], exports: { skills: { review: "skills/review" } } }));
  const a = join(mkdtempSync(join(tmpdir(), "raw-pack-a-")), "review.rawpkg");
  const b = join(mkdtempSync(join(tmpdir(), "raw-pack-b-")), "review.rawpkg");
  await packPackage(root, a);
  utimesSync(skill, new Date(1990, 0, 1), new Date(1990, 0, 1));
  await packPackage(root, b);
  assert.deepEqual(readFileSync(a), readFileSync(b));
  const report = await validatePackageArchive(a);
  assert.equal(report.manifest.name, "@example/review");
  const extracted = mkdtempSync(join(tmpdir(), "raw-pack-extracted-"));
  await unpackPackage(a, extracted);
  assert.equal(readFileSync(join(extracted, "skills", "review", "SKILL.md"), "utf8"), readFileSync(skill, "utf8"));
  assert.equal(statSync(join(extracted, "skills", "review", "SKILL.md")).mode & 0o111, 0o111);
});

test("corrupt archives fail validation before extraction", async () => {
  const bad = join(mkdtempSync(join(tmpdir(), "raw-pack-corrupt-")), "bad.rawpkg");
  writeFileSync(bad, Buffer.from("not a ZIP"));
  await assert.rejects(validatePackageArchive(bad), /archive|zip|invalid/i);
});

test("archive reader rejects traversal, links, case conflicts and missing inventory", async () => {
  const make = async (entries: Array<{ name: string; text: string; mode?: number }>) => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
    for (const entry of entries) await writer.add(entry.name, new TextReader(entry.text),
      entry.mode === undefined ? {} : { unixMode: entry.mode });
    const path = join(mkdtempSync(join(tmpdir(), "raw-hostile-zip-")), "hostile.rawpkg");
    writeFileSync(path, await writer.close());
    return path;
  };
  await assert.rejects(validatePackageArchive(await make([{ name: "../escape", text: "x" }])), /path|archive/i);
  await assert.rejects(validatePackageArchive(await make([{ name: "link", text: "../escape", mode: 0o120777 }])), /link|archive/i);
  await assert.rejects(validatePackageArchive(await make([{ name: "A", text: "a" }, { name: "a", text: "b" }])), /case|duplicate/i);
  await assert.rejects(validatePackageArchive(await make([{ name: "raw-package.json", text: "{}" }])), /inventory/i);
  await assert.rejects(validatePackageArchive(await make([{ name: "too-large", text: "x".repeat(16 * 1024 * 1024 + 1) }])),
    /expanded|limit|size/i);
});

test("a declared nested dependency must itself be a valid artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-nested-package-"));
  mkdirSync(join(root, "agents")); mkdirSync(join(root, "deps"));
  writeFileSync(join(root, "agents", "root.json"), "{}");
  const bytes = Buffer.from("invalid nested archive");
  writeFileSync(join(root, "deps", "other.rawpkg"), bytes);
  writeFileSync(join(root, "raw-package.json"), JSON.stringify({ schema_version: 1, name: "@example/root", version: "1.0.0",
    description: "Root", files: ["agents/root.json", "deps/other.rawpkg"], exports: { agents: { root: "agents/root.json" } },
    dependencies: { other: { name: "@example/other", version: "1.0.0",
      digest: createHash("sha256").update(bytes).digest("hex"), archive: "deps/other.rawpkg" } } }));
  await assert.rejects(packPackage(root, join(root, "root.rawpkg")), /ZIP|archive|invalid/i);
});
