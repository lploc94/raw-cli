import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ToolManifest } from "./contract.js";

interface OwnedFile { path: string; bytes: Buffer; mode: number }

async function ownedFiles(folder: string, root: string, prefix = "", parents = new Set<string>()): Promise<OwnedFile[]> {
  const actualDirectory = await realpath(join(folder, prefix));
  if (parents.has(actualDirectory)) throw new Error(`selected tool contains a directory link cycle: ${prefix}`);
  const ancestors = new Set(parents).add(actualDirectory);
  const output: OwnedFile[] = [];
  for (const entry of (await readdir(join(folder, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(folder, path);
    if (entry.isSymbolicLink()) {
      const target = await realpath(absolute);
      const suffix = relative(root, target);
      if (suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\") || isAbsolute(suffix)) {
        throw new Error(`selected tool file escapes its folder: ${path}`);
      }
    }
    const kind = entry.isSymbolicLink() ? await stat(absolute) : entry;
    if (kind.isDirectory()) output.push(...await ownedFiles(folder, root, path, ancestors));
    else if (kind.isFile()) {
      const before = await stat(absolute);
      const bytes = await readFile(absolute);
      const after = await stat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw new Error(`selected tool changed while loading: ${path}`);
      }
      output.push({ path, bytes, mode: after.mode & 0o777 });
    } else throw new Error(`unsupported selected tool file: ${path}`);
  }
  return output;
}

function hashFiles(id: string, files: readonly OwnedFile[], manifest: ToolManifest, behavioral: boolean): string {
  const hash = createHash("sha256").update(id).update("\0");
  for (const file of files) {
    const bytes = behavioral && file.path === "tool.json"
      ? Buffer.from(JSON.stringify({ ...manifest, version: undefined })) : file.bytes;
    hash.update(file.path).update("\0").update(String(file.mode)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export async function selectedToolSnapshot(id: string, folder: string, manifest: ToolManifest,
  manifestBytes: Buffer, builtin: boolean): Promise<{
  sourceDigest: string; entryPath: string;
}> {
  const root = await realpath(folder);
  const before = await ownedFiles(folder, root);
  const files = await ownedFiles(folder, root);
  if (hashFiles(id, before, manifest, false) !== hashFiles(id, files, manifest, false)) {
    throw new Error(`selected tool changed while loading: ${id}`);
  }
  if (!files.find((file) => file.path === "tool.json")?.bytes.equals(manifestBytes)) {
    throw new Error(`selected tool manifest changed while loading: ${id}`);
  }
  if (!files.some((file) => file.path === "tool.json") || !files.some((file) => file.path === "index.mjs")) {
    throw new Error(`selected tool files are missing: ${id}`);
  }
  const sourceDigest = hashFiles(id, files, manifest, true);
  if (builtin) return { sourceDigest, entryPath: join(folder, "index.mjs") };
  const snapshotRoot = join(dirname(folder), ".raw-snapshots", basename(folder));
  const fullDigest = hashFiles(id, files, manifest, false);
  const snapshotPath = join(snapshotRoot, fullDigest);
  const entryPath = join(snapshotPath, "index.mjs");
  try {
    await stat(entryPath);
    const existing = await ownedFiles(snapshotPath, await realpath(snapshotPath));
    if (hashFiles(id, existing, manifest, false) !== fullDigest) throw new Error(`selected tool snapshot was modified: ${id}`);
    return { sourceDigest, entryPath };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const stage = join(snapshotRoot, `.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const file of files) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: file.mode, flag: "wx" });
    }
    try { await rename(stage, snapshotPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
  const installed = await ownedFiles(snapshotPath, await realpath(snapshotPath));
  if (hashFiles(id, installed, manifest, false) !== fullDigest) throw new Error(`selected tool snapshot was modified: ${id}`);
  return { sourceDigest, entryPath };
}
