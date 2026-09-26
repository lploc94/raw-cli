import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { packagePath, type RawPackageManifest } from "./contract.js";
import { loadPackageManifest } from "./manifest.js";

const MAX_ENTRIES = 4096;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const INVENTORY = "raw-integrity.json";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface InventoryItem { sha256: string; bytes: number; mode: number }
type Inventory = Record<string, InventoryItem>;
interface ArchiveContents { manifest: RawPackageManifest; files: ReadonlyMap<string, Uint8Array>; inventory: Inventory }

class BoundedWriter extends Uint8ArrayWriter {
  private written = 0;
  override async writeUint8Array(array: Uint8Array): Promise<void> {
    this.written += array.byteLength;
    if (this.written > MAX_FILE) throw new Error("archive entry exceeds expanded file limit");
    await super.writeUint8Array(array);
  }
}

export async function packPackage(root: string, out: string): Promise<{ sha256: string; bytes: number }> {
  const loaded = await loadPackageManifest(root);
  if (loaded.files.includes(INVENTORY)) throw new Error("raw-integrity.json is reserved for the package archive");
  await validateDependencies(loaded.root, loaded.manifest, 0);
  const paths = ["raw-package.json", ...loaded.files.filter((path) => path !== "raw-package.json")].sort();
  if (paths.length + 1 > MAX_ENTRIES) throw new Error("package has too many archive entries");
  const inventory: Inventory = Object.create(null);
  let total = 0;
  const entries: Array<{ path: string; bytes: Uint8Array; mode: number }> = [];
  for (const path of paths) {
    if (path.split("/").length > 16) throw new Error(`package path is too deep: ${path}`);
    const location = join(loaded.root, path);
    const info = await lstat(location);
    if (!info.isFile()) throw new Error(`package archive path is not a regular file: ${path}`);
    if (info.size > MAX_FILE || (total += info.size) > MAX_TOTAL) throw new Error("package exceeds expanded size limit");
    const bytes = await readFile(location);
    const mode = info.mode & 0o111 ? 0o755 : 0o644;
    inventory[path] = { sha256: sha256(bytes), bytes: bytes.length, mode };
    entries.push({ path, bytes, mode });
  }
  const inventoryBytes = Buffer.from(JSON.stringify({ schema_version: 1, files: inventory }) + "\n");
  if (inventoryBytes.length > MAX_FILE || total + inventoryBytes.length > MAX_TOTAL) throw new Error("package inventory exceeds size limit");
  entries.push({ path: INVENTORY, bytes: inventoryBytes, mode: 0o644 });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0, compressionMethod: 0,
    lastModDate: FIXED_DATE, extendedTimestamp: false, keepOrder: true });
  for (const entry of entries) {
    await writer.add(entry.path, new Uint8ArrayReader(entry.bytes), { level: 0, compressionMethod: 0,
      lastModDate: FIXED_DATE, extendedTimestamp: false, unixMode: 0o100000 | entry.mode });
  }
  const result = await writer.close();
  if (result.byteLength > MAX_TOTAL) throw new Error("package archive exceeds size limit");
  await mkdir(dirname(out), { recursive: true });
  const staged = `${out}.tmp-${randomUUID()}`;
  try { await writeFile(staged, result, { flag: "wx" }); await rename(staged, out); }
  catch (error) { await rm(staged, { force: true }); throw error; }
  return { sha256: sha256(result), bytes: result.byteLength };
}

async function validateDependencies(root: string, manifest: RawPackageManifest, depth: number): Promise<void> {
  if (Object.keys(manifest.dependencies ?? {}).length && depth >= 4) throw new Error("package dependency nesting exceeds limit");
  for (const [alias, dependency] of Object.entries(manifest.dependencies ?? {})) {
    const nested = await readArchive(join(root, dependency.archive), depth + 1);
    if (nested.manifest.name !== dependency.name || nested.manifest.version !== dependency.version) {
      throw new Error(`dependency archive identity mismatch: ${alias}`);
    }
  }
}

async function readArchive(archive: string, depth = 0): Promise<ArchiveContents> {
  const info = await stat(archive);
  if (!info.isFile() || info.size > MAX_TOTAL) throw new Error("invalid package archive size");
  let reader: ZipReader<Uint8Array>;
  try { reader = new ZipReader(new Uint8ArrayReader(await readFile(archive))); }
  catch { throw new Error("invalid package ZIP archive"); }
  const files = new Map<string, Uint8Array>();
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ENTRIES) throw new Error("package archive has too many entries");
    const folded = new Map<string, string>();
    let total = 0;
    for (const entry of entries) {
      const path = packagePath(entry.filename);
      if (path.split("/").length > 16) throw new Error(`package archive path is too deep: ${path}`);
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.directory || entry.symlink || entry.encrypted || (unixType !== 0 && unixType !== 0o100000)) {
        throw new Error(`unsupported package archive entry: ${path}`);
      }
      const lowered = path.toLowerCase();
      if (files.has(path) || folded.has(lowered)) throw new Error(`duplicate or case-conflicting package archive path: ${path}`);
      folded.set(lowered, path);
      if (entry.uncompressedSize > MAX_FILE || (total += entry.uncompressedSize) > MAX_TOTAL) {
        throw new Error("package archive exceeds expanded size limit");
      }
      const bytes = await entry.getData(new BoundedWriter());
      if (bytes.byteLength !== entry.uncompressedSize) throw new Error(`archive size mismatch: ${path}`);
      files.set(path, bytes);
    }
  } catch (error) {
    throw new Error(`invalid package ZIP archive: ${(error as Error).message}`);
  } finally { await reader.close(); }
  const inventoryBytes = files.get(INVENTORY);
  if (!inventoryBytes) throw new Error("package archive is missing integrity inventory");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(inventoryBytes).toString("utf8")); }
  catch { throw new Error("invalid package archive integrity inventory"); }
  if (!parsed || typeof parsed !== "object" || (parsed as { schema_version?: number }).schema_version !== 1) {
    throw new Error("invalid package archive integrity inventory");
  }
  const inventory = (parsed as { files?: Inventory }).files;
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) throw new Error("invalid package archive integrity inventory");
  files.delete(INVENTORY);
  if (Object.keys(inventory).length !== files.size) throw new Error("package archive integrity inventory does not cover files");
  for (const [path, bytes] of files) {
    const record = inventory[path];
    if (!record || record.sha256 !== sha256(bytes) || record.bytes !== bytes.byteLength
      || (record.mode !== 0o644 && record.mode !== 0o755)) throw new Error(`package archive integrity mismatch: ${path}`);
  }
  const manifestBytes = files.get("raw-package.json");
  if (!manifestBytes) throw new Error("package archive has no manifest");
  let manifest: RawPackageManifest;
  const temporary = await mkdtemp(join(tmpdir(), "raw-archive-validate-"));
  try {
    await writeExtracted(files, inventory, temporary);
    const loaded = await loadPackageManifest(temporary);
    manifest = loaded.manifest;
    const expected = new Set(["raw-package.json", ...loaded.files]);
    if (expected.size !== files.size || [...files.keys()].some((path) => !expected.has(path))) {
      throw new Error("package archive has undeclared or missing files");
    }
    await validateDependencies(temporary, manifest, depth);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { manifest, files, inventory };
}

async function writeExtracted(files: ReadonlyMap<string, Uint8Array>, inventory: Inventory, destination: string): Promise<void> {
  for (const [path, bytes] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await chmod(target, inventory[path]!.mode);
  }
}

export async function validatePackageArchive(archive: string): Promise<{ manifest: RawPackageManifest; files: readonly string[] }> {
  const result = await readArchive(archive);
  return { manifest: result.manifest, files: [...result.files.keys()].sort() };
}

export async function unpackPackage(archive: string, destination: string): Promise<void> {
  const result = await readArchive(archive);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error(`package extraction destination is not empty: ${destination}`);
  await writeExtracted(result.files, result.inventory, destination);
}
