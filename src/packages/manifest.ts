import { readFile, lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import semver from "semver";
import schema from "../../schemas/raw-package.schema.json" with { type: "json" };
import { componentKinds, deepFreeze, packagePath, type RawPackageManifest } from "./contract.js";
import { parseInputSchema } from "./inputs.js";

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

function rejectDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const entry of node.children ?? []) {
      const key = String(getNodeValue(entry.children?.[0]!));
      if (seen.has(key)) throw new Error(`duplicate package manifest field: ${key}`);
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

export function parsePackageManifest(source: string): RawPackageManifest {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("package manifest is too large");
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) throw new Error("invalid package manifest JSON");
  rejectDuplicateKeys(tree);
  const data: unknown = getNodeValue(tree);
  if (!validate(data)) throw new Error(`invalid package manifest: ${ajv.errorsText(validate.errors)}`);
  const manifest = data as unknown as RawPackageManifest;
  if (!semver.valid(manifest.version) || manifest.version !== semver.valid(manifest.version)) throw new Error("invalid package version");
  if (!manifest.description.trim()) throw new Error("package description is empty");
  for (const path of manifest.files) packagePath(path);
  for (const kind of componentKinds) for (const path of Object.values(manifest.exports[kind] ?? {})) packagePath(path);
  if (manifest.inputs !== undefined) parseInputSchema(manifest.inputs);
  for (const dependency of Object.values(manifest.dependencies ?? {})) {
    if (!semver.valid(dependency.version) || dependency.version !== semver.valid(dependency.version)) throw new Error("invalid dependency version");
    packagePath(dependency.archive);
    if (!manifest.files.some((path) => dependency.archive === path || dependency.archive.startsWith(`${path}/`))) {
      throw new Error(`dependency archive is not declared in files: ${dependency.archive}`);
    }
  }
  return deepFreeze(manifest);
}

export interface LoadedPackageManifest { root: string; manifest: RawPackageManifest; files: readonly string[] }

export async function loadPackageManifest(root: string): Promise<LoadedPackageManifest> {
  const absolute = await realpath(resolve(root));
  const manifest = parsePackageManifest(await readFile(join(absolute, "raw-package.json"), "utf8"));
  const files = new Map<string, string>();
  const folded = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    packagePath(path);
    const absolutePath = join(absolute, path);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new Error(`package symlink is unsupported: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolutePath)).sort()) await visit(`${path}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error(`unsupported package file type: ${path}`);
    const real = await realpath(absolutePath);
    const rel = relative(absolute, real);
    if (rel !== path) throw new Error(`package path escapes root: ${path}`);
    const lowercase = path.toLowerCase();
    if (folded.has(lowercase) && folded.get(lowercase) !== path) throw new Error(`case-conflicting package path: ${path}`);
    folded.set(lowercase, path);
    files.set(path, real);
  };
  for (const path of manifest.files) await visit(path);
  for (const kind of componentKinds) for (const [name, path] of Object.entries(manifest.exports[kind] ?? {})) {
    if (!files.has(path) && ![...files.keys()].some((file) => file.startsWith(`${path}/`))) {
      throw new Error(`uncovered package export ${kind}/${name}: ${path}`);
    }
  }
  return { root: absolute, manifest, files: Object.freeze([...files.keys()].sort()) };
}
