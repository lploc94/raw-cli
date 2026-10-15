import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { listWorkspaceFiles, readWorkspaceFileText, readWorkspaceImage, imageMediaType, MAX_TEXT_BYTES, type WorkspaceFileListing, type WorkspaceFileText } from "../src/dashboard/files.js";
import { MAX_IMAGE_BYTES } from "../src/tools/types.js";
import { dashboardFixture } from "./fixtures/dashboard.js";

function tempDir(prefix: string): string { return realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); }
function write(root: string, path: string, text = "x"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function git(cwd: string, ...args: string[]): void { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" }); }
const paths = (listing: WorkspaceFileListing) => listing.entries.map((entry) => entry.path);
/** The text branch of a read, asserted rather than assumed; the binary branch has its own helper. */
function asText(file: WorkspaceFileText): { path: string; bytes: number; text: string; truncated: boolean } {
  assert.ok(!("binary" in file), `expected text, got a binary report for ${file.path}`);
  return file as { path: string; bytes: number; text: string; truncated: boolean };
}
function asBinary(file: WorkspaceFileText): { path: string; bytes: number; binary: true } {
  assert.ok("binary" in file, `expected a binary report, got text for ${file.path}`);
  return file as { path: string; bytes: number; binary: true };
}
async function error(f: Awaited<ReturnType<typeof dashboardFixture>>, path: string): Promise<{ status: number; code: string }> {
  const response = await f.api(path);
  return { status: response.status, code: (JSON.parse(await response.text()) as { error: { code: string } }).error.code };
}

test("the listing is workspace-relative when the workspace is a subdirectory of a repository", async () => {
  const repo = tempDir("raw-files-repo-");
  try {
    write(repo, "sub/a.ts", "a");
    write(repo, "sub/deep/b.ts", "b");
    write(repo, "sub/notes.log", "noise");
    write(repo, "sub/.gitignore", "*.log\n");
    write(repo, "root.ts", "r");
    git(repo, "init", "-q");
    git(repo, "add", "-A");

    const listing = await listWorkspaceFiles(join(repo, "sub"));
    assert.deepEqual(paths(listing), [".gitignore", "a.ts", "deep/b.ts"]);
    assert.deepEqual(listing.entries.map((entry) => entry.name), [".gitignore", "a.ts", "b.ts"]);
    assert.equal(listing.total, 3);
    assert.equal(listing.truncated, false);
    assert.equal(listing.root, realpathSync.native(join(repo, "sub")));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the listing skips .git and node_modules, scopes to the workspace and reports its cap", async () => {
  const root = tempDir("raw-files-plain-");
  try {
    write(root, "README.md", "readme");
    write(root, "src/app.ts", "app");
    write(root, "src/deep/x.ts", "x");
    write(root, "node_modules/pkg/index.js", "dep");
    write(root, ".git/config", "[core]");

    const all = await listWorkspaceFiles(root);
    assert.deepEqual(paths(all), ["README.md", "src/app.ts", "src/deep/x.ts"]);
    assert.equal(all.total, 3);
    assert.equal(all.truncated, false);

    const capped = await listWorkspaceFiles(root, { max: 2 });
    assert.deepEqual(paths(capped), ["README.md", "src/app.ts"]);
    assert.equal(capped.total, 3);
    assert.equal(capped.truncated, true);

    const inside = await listWorkspaceFiles(join(root, "src"));
    assert.deepEqual(paths(inside), ["app.ts", "deep/x.ts"]);

    // A workspace that cannot be read says so with its own code, whether it is missing or is not a directory.
    for (const bad of [join(root, "missing"), join(root, "README.md")])
      await assert.rejects(() => listWorkspaceFiles(bad), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "unreadable_directory", bad);
        return true;
      }, bad);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tracked node_modules entry is still not part of the workspace view", async () => {
  const repo = tempDir("raw-files-forced-");
  try {
    write(repo, "app.ts", "app");
    write(repo, "node_modules/pkg/index.js", "dep");
    git(repo, "init", "-q");
    git(repo, "add", "-A", "-f");

    assert.deepEqual(paths(await listWorkspaceFiles(repo)), ["app.ts"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("an empty workspace lists nothing rather than failing", async () => {
  const root = tempDir("raw-files-empty-");
  try {
    const listing = await listWorkspaceFiles(root);
    assert.deepEqual(paths(listing), []);
    assert.equal(listing.total, 0);
    assert.equal(listing.truncated, false);
    await assert.rejects(() => listWorkspaceFiles(join(root, "missing")), /cannot be read/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the files route answers the selected workspace listing and validates cwd", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  const selected = tempDir("raw-files-selected-");
  try {
    write(f.root, "app.ts", "app");
    write(f.root, "same.txt", "default");
    write(f.root, "src/deep/x.ts", "x");
    write(selected, "same.txt", "selected");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(selected, "same.png"), png);
    const listing = await f.json<WorkspaceFileListing>(`/workspaces/files?cwd=${encodeURIComponent(selected)}`);
    assert.equal(listing.root, realpathSync.native(selected));
    assert.deepEqual(paths(listing), ["same.png", "same.txt"]);
    const text = await f.json<WorkspaceFileText>(`/workspaces/file?cwd=${encodeURIComponent(selected)}&path=${encodeURIComponent("same.txt")}`);
    assert.deepEqual(text, { path: "same.txt", bytes: 8, text: "selected", truncated: false });
    const raw = await f.api(`/workspaces/file?cwd=${encodeURIComponent(selected)}&raw=1&path=${encodeURIComponent("same.png")}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
    const defaultListing = await f.json<WorkspaceFileListing>("/workspaces/files");
    assert.ok(paths(defaultListing).includes("app.ts"));
    const invalidCwd = encodeURIComponent(join(selected, "missing"));
    assert.equal((await error(f, `/workspaces/files?cwd=${invalidCwd}`)).code, "invalid_workspace");
    assert.equal((await error(f, `/workspaces/file?cwd=${invalidCwd}&path=same.txt`)).code, "invalid_workspace");
    assert.equal((await error(f, `/workspaces/file?cwd=${invalidCwd}&raw=1&path=same.png`)).code, "invalid_workspace");
  } finally { await f.close(); rmSync(selected, { recursive: true, force: true }); }
});

test("a fresh listing bypasses the short workspace cache", async () => {
  const root = tempDir("raw-files-refresh-");
  try {
    write(root, "before.txt", "before");
    assert.deepEqual(paths(await listWorkspaceFiles(root)), ["before.txt"]);
    write(root, "after.txt", "after");
    assert.deepEqual(paths(await listWorkspaceFiles(root)), ["before.txt"]);
    assert.deepEqual(paths(await listWorkspaceFiles(root, { bypassCache: true })), ["after.txt", "before.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reading a file returns its text, its size and whether it was cut", async () => {
  const root = tempDir("raw-files-read-");
  try {
    write(root, "src/app.ts", "const a = 1;\n");
    write(root, "notes/ghi chú #1 100%.md", "# Ghi chú\n");
    const text = await readWorkspaceFileText(root, "src/app.ts");
    assert.deepEqual(text, { path: "src/app.ts", bytes: 13, text: "const a = 1;\n", truncated: false });
    // A name with a space, a hash, a percent sign and non-ASCII characters round-trips unchanged.
    const unicode = await readWorkspaceFileText(root, "notes/ghi chú #1 100%.md");
    assert.equal(unicode.path, "notes/ghi chú #1 100%.md");
    assert.equal(asText(unicode).text, "# Ghi chú\n");
    // A Windows-style spelling of the same path is accepted and answered with the canonical one.
    if (process.platform === "win32") assert.equal((await readWorkspaceFileText(root, "src\\app.ts")).path, "src/app.ts");

    const big = "a".repeat(MAX_TEXT_BYTES + 500_000);
    write(root, "big.txt", big);
    const cut = asText(await readWorkspaceFileText(root, "big.txt"));
    assert.equal(cut.truncated, true);
    assert.equal(cut.bytes, big.length);
    assert.equal(Buffer.byteLength(cut.text), MAX_TEXT_BYTES);

    // Exactly at the cap is not cut: the flag tracks the file, not the read.
    write(root, "exact.txt", "a".repeat(MAX_TEXT_BYTES));
    const exact = asText(await readWorkspaceFileText(root, "exact.txt"));
    assert.equal(exact.truncated, false);
    assert.equal(Buffer.byteLength(exact.text), MAX_TEXT_BYTES);

    // A cut inside a multi-byte character keeps the text valid rather than ending in a replacement character.
    // The prefix is two bytes so the 1 MiB cut lands inside a three-byte character instead of on its boundary.
    const mixed = "xx" + "€".repeat(400_000);
    write(root, "mixed.txt", mixed);
    const boundary = asText(await readWorkspaceFileText(root, "mixed.txt"));
    assert.equal(boundary.truncated, true);
    assert.ok(!boundary.text.includes("\uFFFD"), "no replacement character");
    assert.ok(Buffer.byteLength(boundary.text) < MAX_TEXT_BYTES);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a binary file is named rather than decoded", async () => {
  const root = tempDir("raw-files-binary-");
  try {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0x0d, 0x0a]));
    write(root, "empty.txt", "");
    assert.deepEqual(await readWorkspaceFileText(root, "blob.bin"), { path: "blob.bin", bytes: 7, binary: true });
    assert.equal(asText(await readWorkspaceFileText(root, "empty.txt")).text, "");
    // Bytes that are not UTF-8 at all are named too, rather than shown as replacement characters.
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    assert.deepEqual(await readWorkspaceFileText(root, "latin1.txt"), { path: "latin1.txt", bytes: 5, binary: true });
    // A NUL after the first 8 KiB is not what decides: that window is the check, and the file stays text.
    writeFileSync(join(root, "late.bin"), Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0x00, 0x62])]));
    const late = asText(await readWorkspaceFileText(root, "late.bin"));
    assert.equal(late.truncated, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reading refuses everything outside the workspace and everything that is not a file", async (t) => {
  const root = tempDir("raw-files-refuse-");
  const other = tempDir("raw-files-outside-");
  try {
    write(root, "keep.txt", "keep");
    mkdirSync(join(root, "folder"));
    write(other, "secret.txt", "secret");
    write(root, ".env", "secret env");
    write(root, ".git/config", "git internals");
    write(root, "node_modules/pkg.js", "dependency");
    write(root, ".git/secret.txt", "hidden target");
    // A directory link out of the workspace is unprivileged where the platform allows links at all (a junction on
    // Windows, a dir symlink elsewhere), and reading through it is what the realpath check must refuse. Hosts that
    // refuse to create one (Windows without Developer Mode: the same reason this repository's own symlink tests
    // fail there) run every other case and say so.
    let linked = true;
    try { symlinkSync(other, join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); }
    catch { linked = false; t.diagnostic("this host refuses to create a directory link; the escape case is skipped"); }
    let hiddenLinked = true;
    try {
      symlinkSync(join(root, ".git"), join(root, "visible"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(join(root, "node_modules"), join(root, "dependencies"), process.platform === "win32" ? "junction" : "dir");
    }
    catch { hiddenLinked = false; t.diagnostic("this host refuses to create an in-workspace directory link; the canonical hidden-segment case is skipped"); }
    assert.equal(asText(await readWorkspaceFileText(root, ".env")).text, "secret env");
    const cases: Array<[string, unknown]> = [
      ["parent traversal", "../secret.txt"],
      ["absolute path", join(other, "secret.txt")],
      ["NUL byte", "a\0b"],
      ["at the length cap but not a real file", `${"a".repeat(4096)}.txt`],
      ["over the length cap", `${"a".repeat(4097)}.txt`],
      ["the workspace root itself", "."],
      ["a directory", "folder"],
      ["a direct .git path", ".git/config"],
      ["a direct node_modules path", "node_modules/pkg.js"],
      ...(process.platform === "win32" ? [["case-insensitive node_modules path", "NODE_MODULES/pkg.js"]] as Array<[string, unknown]> : []),
      ...(hiddenLinked ? [
        ["a symlink target .git path", "visible/secret.txt"],
        ["a symlink target node_modules path", "dependencies/pkg.js"],
      ] as Array<[string, unknown]> : []),
      ...(linked ? [["a path through a link that leaves the workspace", "escape/secret.txt"]] as Array<[string, unknown]> : []),
      ["a file that is gone", "missing.txt"],
      ["an empty string", ""],
      ["not a string", 42],
    ];
    for (const [name, value] of cases)
      await assert.rejects(() => readWorkspaceFileText(root, value), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_file", name);
        return true;
      }, name);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("the file route answers text, binary and its error codes", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  try {
    write(f.root, "app.ts", "app");
    writeFileSync(join(f.root, "blob.bin"), Buffer.from([0x01, 0x00, 0x02]));
    const text = await f.json<WorkspaceFileText>(`/workspaces/file?path=${encodeURIComponent("app.ts")}`);
    assert.deepEqual(text, { path: "app.ts", bytes: 3, text: "app", truncated: false });
    const binary = await f.json<WorkspaceFileText>(`/workspaces/file?path=${encodeURIComponent("blob.bin")}`);
    assert.deepEqual(binary, { path: "blob.bin", bytes: 3, binary: true });

    assert.deepEqual(await error(f, "/workspaces/file"), { status: 400, code: "invalid_input" });
    assert.deepEqual(await error(f, "/workspaces/file?path="), { status: 400, code: "invalid_input" });
    for (const value of ["../secret.txt", join(f.root, "app.ts"), "missing.txt", "."]) {
      const refused = await error(f, `/workspaces/file?path=${encodeURIComponent(value)}`);
      assert.deepEqual(refused, { status: 422, code: "invalid_file" }, value);
    }

    // A file the listing showed and something removed before the click is an invalid file, not a crash.
    write(f.root, "gone.txt", "bye");
    rmSync(join(f.root, "gone.txt"));
    assert.deepEqual(await error(f, `/workspaces/file?path=${encodeURIComponent("gone.txt")}`), { status: 422, code: "invalid_file" });
  } finally { await f.close(); }
});

test("images are offered by extension, case-insensitively, and nothing else is", async () => {
  const root = tempDir("raw-files-image-");
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(root, "logo.png"), png);
    writeFileSync(join(root, "SHOT.PNG"), png);
    write(root, "notes.txt", "text");
    write(root, "drawing.svg", "<svg/>");
    write(root, "photo.jpeg", "not really a jpeg");
    mkdirSync(join(root, "trap.png"));

    assert.equal(imageMediaType("logo.png"), "image/png");
    assert.equal(imageMediaType("SHOT.PNG"), "image/png");
    assert.equal(imageMediaType("photo.JPEG"), "image/jpeg");
    assert.equal(imageMediaType("scan.jpg"), "image/jpeg");
    assert.equal(imageMediaType("a.gif"), "image/gif");
    assert.equal(imageMediaType("a.webp"), "image/webp");
    for (const name of ["notes.txt", "drawing.svg", "noext", "a.png.txt"]) assert.equal(imageMediaType(name), undefined, name);

    const served = await readWorkspaceImage(root, "logo.png");
    assert.equal(served.mediaType, "image/png");
    assert.deepEqual(served.bytes, png);
    // A .png whose bytes are not an image is still served by extension; noticing is the viewer's job.
    assert.equal((await readWorkspaceImage(root, "photo.jpeg")).mediaType, "image/jpeg");
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES, 0x61);
    writeFileSync(join(root, "at-limit.png"), atLimit);
    assert.deepEqual((await readWorkspaceImage(root, "at-limit.png")).bytes, atLimit);

    // Raw mode refuses by extension (415) and by path (422), and the two are different answers.
    for (const [name, value, code] of [
      ["a text file", "notes.txt", "unsupported_media_type"],
      ["an svg", "drawing.svg", "unsupported_media_type"],
      ["a directory named like an image", "trap.png", "invalid_file"],
      ["a missing image", "gone.png", "invalid_file"],
    ] as Array<[string, string, string]>)
      await assert.rejects(() => readWorkspaceImage(root, value), (error: unknown) => {
        assert.equal((error as { code?: string }).code, code, name);
        return true;
      }, name);

    // The cap is the shared image budget rather than a repeated number, and the route answers with the same code.
    writeFileSync(join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await assert.rejects(() => readWorkspaceImage(root, "huge.png"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "unsupported_media_type");
      assert.equal((error as { status?: number }).status, 415);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw image reads reject a file that outgrows the budget after path resolution", async (t) => {
  const root = tempDir("raw-files-growing-image-");
  const path = join(root, "growing.png");
  writeFileSync(path, "small image");
  const originalStat = fsPromises.stat;
  let grew = false;
  t.mock.method(fsPromises, "stat", async (...args: Parameters<typeof originalStat>) => {
    const info = await originalStat(...args);
    if (!grew && args[0] === path) {
      grew = true;
      writeFileSync(path, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => readWorkspaceImage(root, "growing.png"), (error: unknown) => {
      assert.ok(error && typeof error === "object" && "status" in error && "code" in error);
      assert.equal(error.status, 415);
      assert.equal(error.code, "unsupported_media_type");
      return true;
    });
    assert.equal(grew, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the raw route serves image bytes with the headers a browser needs", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(f.root, "logo.png"), png);
    write(f.root, "notes.txt", "text");
    write(f.root, "drawing.svg", "<svg/>");
    for (const extension of ["constructor", "__proto__", "tostring", "hasownproperty"]) {
      const name = `unsupported.${extension}`;
      write(f.root, name, "not an image");
      assert.deepEqual(await error(f, `/workspaces/file?raw=1&path=${encodeURIComponent(name)}`),
        { status: 415, code: "unsupported_media_type" }, extension);
    }

    const response = await f.api(`/workspaces/file?raw=1&path=${encodeURIComponent("logo.png")}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(png.length));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

    // Without raw=1 the same route still answers text, and each refusal keeps its code.
    assert.equal((await f.json<WorkspaceFileText>(`/workspaces/file?path=${encodeURIComponent("notes.txt")}`)).path, "notes.txt");
    assert.deepEqual(await error(f, `/workspaces/file?raw=1&path=${encodeURIComponent("notes.txt")}`), { status: 415, code: "unsupported_media_type" });
    assert.deepEqual(await error(f, `/workspaces/file?raw=1&path=${encodeURIComponent("drawing.svg")}`), { status: 415, code: "unsupported_media_type" });
    assert.deepEqual(await error(f, `/workspaces/file?raw=1&path=${encodeURIComponent("../secret.png")}`), { status: 422, code: "invalid_file" });
    assert.deepEqual(await error(f, "/workspaces/file?raw=1"), { status: 400, code: "invalid_input" });

    // The budget is a budget over the wire too, not only in the reader.
    writeFileSync(join(f.root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    assert.deepEqual(await error(f, `/workspaces/file?raw=1&path=${encodeURIComponent("huge.png")}`), { status: 415, code: "unsupported_media_type" });

    // The length cap is a shape check over the whole path: exactly 4096 characters gets past it and fails as a file
    // that is not there, while 4097 is refused before anything is read.
    const long = await f.api(`/workspaces/file?path=${encodeURIComponent(`${"a".repeat(4092)}.txt`)}`);
    assert.equal(JSON.parse(await long.text()).error.message, "That file no longer exists");
    const longer = await f.api(`/workspaces/file?path=${encodeURIComponent(`${"a".repeat(4093)}.txt`)}`);
    assert.equal(JSON.parse(await longer.text()).error.message, "Choose a file inside this workspace");
  } finally { await f.close(); }
});
