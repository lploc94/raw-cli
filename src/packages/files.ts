import { copyFile, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix);
}

export async function copyOwnedTree(source: string, destination: string): Promise<readonly string[]> {
  const root = await realpath(source);
  const targetRoot = resolve(destination);
  if (contained(root, targetRoot)) throw new Error(`export destination is inside selected source folder: ${source}`);
  const copied: string[] = [];
  const walk = async (path: string, parents: ReadonlySet<string>): Promise<void> => {
    const actualDirectory = await realpath(path);
    if (parents.has(actualDirectory)) throw new Error(`owned package folder link cycle: ${path}`);
    const chain = new Set(parents); chain.add(actualDirectory);
    for (const name of (await readdir(path)).sort()) {
      const from = join(path, name);
      const target = await realpath(from);
      if (!contained(root, target)) throw new Error(`owned package file escapes source folder: ${from}`);
      const info = await lstat(from);
      const targetInfo = info.isSymbolicLink() ? await stat(target) : info;
      const relativePath = relative(root, from);
      if (targetInfo.isDirectory()) { await walk(from, chain); continue; }
      if (!targetInfo.isFile()) throw new Error(`unsupported owned package file: ${from}`);
      const to = join(destination, relativePath);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(target, to);
      copied.push(relativePath);
    }
  };
  await walk(root, new Set());
  return copied;
}

export async function copyOwnedFile(source: string, destination: string): Promise<void> {
  const actual = await realpath(resolve(source));
  const info = await lstat(actual);
  if (!info.isFile()) throw new Error(`not a regular package file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(actual, destination);
}
