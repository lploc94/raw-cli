import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestorFolders, buildTree, countFiles, fileKind, filterTree, type TreeFolder } from "../web/src/files/tree.js";

/** The tree as nested plain names, so an assertion reads like the structure rather than like the builder. */
function shape(folder: TreeFolder): Array<string | Record<string, unknown>> {
  return [
    ...folder.folders.map((child) => ({ [child.name]: shape(child) })),
    ...folder.files.map((file) => file.path),
  ];
}

test("a flat listing becomes a tree, folders first and both case-insensitive", () => {
  const tree = buildTree(["b/x.ts", "a.ts", "b/deep/y.ts", "Alpha/z.ts"]);
  assert.deepEqual(shape(tree), [
    { Alpha: ["Alpha/z.ts"] },
    { b: [{ deep: ["b/deep/y.ts"] }, "b/x.ts"] },
    "a.ts",
  ]);
  assert.equal(tree.name, "");
  assert.equal(tree.path, "");
  const deep = tree.folders.find((folder) => folder.name === "b")!.folders[0]!;
  assert.equal(deep.path, "b/deep");
  assert.deepEqual(deep.files, [{ name: "y.ts", path: "b/deep/y.ts" }]);
  // Sorting is case-insensitive, so a lower-case folder does not sort after an upper-case one.
  assert.deepEqual(buildTree(["zz/a.ts", "Alpha/b.ts"]).folders.map((folder) => folder.name), ["Alpha", "zz"]);
});

test("the tree ignores duplicates, blanks and empty segments", () => {
  const tree = buildTree(["a.ts", "a.ts", "", "/", "src//b.ts", "src/"]);
  assert.equal(countFiles(tree), 2);
  assert.deepEqual(shape(tree), [{ src: ["src/b.ts"] }, "a.ts"]);
  assert.deepEqual(shape(buildTree([])), []);
});

test("names with spaces, hashes and non-ASCII characters survive the tree", () => {
  const tree = buildTree(["tài liệu/ghi chú #1 100%.md"]);
  assert.deepEqual(shape(tree), [{ "tài liệu": ["tài liệu/ghi chú #1 100%.md"] }]);
  assert.equal(tree.folders[0]!.files[0]!.name, "ghi chú #1 100%.md");
});

test("filtering keeps matching files with their ancestors and drops empty branches", () => {
  const tree = buildTree(["b/x.ts", "a.ts", "b/deep/y.ts", "other/z.md"]);
  const hit = filterTree(tree, "DEEP/");
  assert.deepEqual(shape(hit), [{ b: [{ deep: ["b/deep/y.ts"] }] }]);
  assert.equal(countFiles(hit), 1);
  // A name match works on the whole path, and nothing matching leaves an empty tree.
  assert.deepEqual(shape(filterTree(tree, "z.md")), [{ other: ["other/z.md"] }]);
  assert.equal(countFiles(filterTree(tree, "nothing-here")), 0);
  assert.deepEqual(shape(filterTree(tree, "nothing-here")), []);
  // An empty or blank query is not a filter at all.
  assert.equal(filterTree(tree, ""), tree);
  assert.equal(filterTree(tree, "   "), tree);
});

test("ancestors and kinds are what the page needs to open a file", () => {
  assert.deepEqual(ancestorFolders("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestorFolders("a.ts"), []);
  assert.deepEqual(ancestorFolders(""), []);
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("notes.MARKDOWN"), "markdown");
  assert.equal(fileKind("logo.PNG"), "image");
  assert.equal(fileKind("scan.jpeg"), "image");
  assert.equal(fileKind("a.webp"), "image");
  assert.equal(fileKind("a.gif"), "image");
  assert.equal(fileKind("app.ts"), "text");
  assert.equal(fileKind("drawing.svg"), "text");
  assert.equal(fileKind("noext"), "text");
  assert.equal(fileKind("a.png.txt"), "text");
});
