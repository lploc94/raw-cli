import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Asset { path: string; bytes: Buffer; mode: number }

async function inventory(folder: string): Promise<Asset[]> {
  const files: Asset[] = [];
  let total = 0;
  const visit = async (prefix: string): Promise<void> => {
    for (const entry of (await readdir(join(folder, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`selected hook contains a link: ${path}`);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error(`unsupported selected hook file: ${path}`);
      const absolute = join(folder, path);
      const before = await stat(absolute);
      if (before.size > 16 * 1024 * 1024 || (total += before.size) > 16 * 1024 * 1024 || files.length >= 256) {
        throw new Error("selected hook exceeds snapshot limit");
      }
      const bytes = await readFile(absolute);
      const after = await stat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw new Error(`selected hook changed while loading: ${path}`);
      }
      files.push({ path, bytes, mode: after.mode & 0o777 });
    }
  };
  await visit("");
  return files;
}

function digest(files: readonly Asset[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(String(file.mode))
    .update("\0").update(String(file.bytes.length)).update("\0").update(file.bytes);
  return hash.digest("hex");
}

export async function snapshotHook(folder: string, configPath: string, id: string): Promise<string> {
  const first = await inventory(folder);
  const second = await inventory(folder);
  const hash = digest(first);
  if (hash !== digest(second)) throw new Error(`selected hook changed while loading: ${id}`);
  const root = join(dirname(configPath), ".raw-hook-snapshots");
  const destination = join(root, hash);
  try {
    if (digest(await inventory(destination)) !== hash) throw new Error(`selected hook snapshot modified: ${id}`);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = join(root, `.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const file of first) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: file.mode, flag: "wx" });
    }
    try { await rename(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
  if (digest(await inventory(destination)) !== hash) throw new Error(`selected hook snapshot modified: ${id}`);
  return destination;
}
