import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, link } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withPackageWriteLock } from "../packages/lock.js";

export const MAX_EDIT_BYTES = 1024 * 1024;
export class ManagementError extends Error {
  constructor(readonly code: "conflict" | "invalid_input" | "not_found" | "read_only" | "in_use", message: string,
    readonly currentRevision?: string) { super(message); this.name = "ManagementError"; }
}
export interface TextSnapshot { source: string; revision: string; exists: boolean }
export const contentRevision = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function validText(source: string): void {
  if (typeof source !== "string" || source.includes("\0") || Buffer.byteLength(source) > MAX_EDIT_BYTES) {
    throw new ManagementError("invalid_input", "text must be UTF-8 without NUL and at most 1 MiB");
  }
}
export async function readText(path: string): Promise<TextSnapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_EDIT_BYTES) throw new ManagementError("invalid_input", "not an editable text file (maximum 1 MiB)");
    const bytes = await readFile(path);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); validText(source);
    return { source, revision: contentRevision(bytes), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: "", revision: "missing", exists: false };
    throw error;
  }
}
export function assertRevision(expected: string | undefined, current: TextSnapshot): void {
  if (expected !== undefined && expected !== current.revision) throw new ManagementError("conflict", "file revision conflict; reload or reapply the draft", current.revision);
}
export async function publishText(path: string, source: string, original: TextSnapshot): Promise<TextSnapshot> {
  validText(source);
  await mkdir(dirname(path), { recursive: true });
  const destination = original.exists ? await realpath(path) : resolve(path);
  const stage = join(dirname(destination), `.raw-write-${randomUUID()}`);
  try {
    const handle = await open(stage, "wx", 0o600);
    try { await handle.writeFile(source, "utf8"); await handle.sync(); } finally { await handle.close(); }
    const current = await readText(path); assertRevision(original.revision, current);
    if (original.exists) {
      if (await realpath(path) !== destination) throw new ManagementError("conflict", "file target changed during save", current.revision);
      await rename(stage, destination);
    } else {
      try { await link(stage, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ManagementError("conflict", "file already exists");
        throw error;
      }
    }
    return { source, revision: contentRevision(Buffer.from(source)), exists: true };
  } finally { await rm(stage, { force: true }); }
}
export async function saveOwnedText(path: string, source: string, expectedRevision: string,
  validate: (source: string) => void | Promise<void>): Promise<TextSnapshot> {
  return withPackageWriteLock(path, async () => {
    const original = await readText(path); assertRevision(expectedRevision, original);
    validText(source); await validate(source); return publishText(path, source, original);
  });
}
export function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(suffix);
}
export function relativeFile(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ManagementError("invalid_input", "invalid relative file path");
  }
  return path;
}
export async function ownedPath(root: string, path: string, allowMissing = false): Promise<string> {
  relativeFile(path);
  const actualRoot = await realpath(root); const target = join(actualRoot, path);
  try {
    const actual = await realpath(target);
    if (!contained(actualRoot, actual)) throw new ManagementError("invalid_input", "file escapes component folder");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error;
    let parent = dirname(target);
    while (true) {
      try {
        if (!contained(actualRoot, await realpath(parent))) throw new ManagementError("invalid_input", "file parent escapes component folder");
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) throw cause;
        parent = dirname(parent);
      }
    }
  }
  return target;
}
