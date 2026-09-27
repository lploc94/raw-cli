import { readFile, lstat, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, posix, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import semver from "semver";
import schema from "../../schemas/raw-package.schema.json" with { type: "json" };
import { componentKinds, deepFreeze, packagePath, type RawPackageManifest } from "./contract.js";
import { parseInputSchema } from "./inputs.js";
import { parseComponentReference } from "./references.js";
import { parseHookManifest } from "../hooks/manifest.js";

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
  for (const path of Object.values(manifest.exports.tools ?? {})) {
    for (const file of files.keys()) {
      if (!file.startsWith(`${path}/`) || !/\.(?:mjs|js|cjs)$/.test(file)) continue;
      const source = await readFile(join(absolute, file), "utf8");
      const referenced = new Set<string>();
      for (const pattern of [/(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["'](\.[^"']+)["']/g,
        /(?:import|require)\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
        /new\s+URL\s*\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g]) {
        for (const match of source.matchAll(pattern)) referenced.add(match[1]!);
      }
      for (const specifier of referenced) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        packagePath(target);
        if (!files.has(target)) throw new Error(`undeclared package helper or asset ${target} referenced by ${file}`);
      }
    }
  }
  for (const [name, path] of Object.entries(manifest.exports.hooks ?? {})) {
    const manifestPath = `${path}/hook.json`;
    if (!files.has(manifestPath)) throw new Error(`missing exported hook manifest: ${manifestPath}`);
    const bytes = await readFile(join(absolute, manifestPath));
    if (bytes.length > 65536) throw new Error(`hook manifest is too large: ${manifestPath}`);
    let hook: ReturnType<typeof parseHookManifest>;
    try { hook = parseHookManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      `#hooks/${name}`, posix.basename(path)); }
    catch (error) { throw new Error(`invalid exported hook ${name}: ${String(error)}`); }
    for (const item of [hook.command, ...hook.args]) if (item.startsWith("./")) {
      const target = posix.normalize(posix.join(path, item));
      packagePath(target);
      if (!target.startsWith(`${path}/`) || !files.has(target)) throw new Error(`undeclared hook asset: ${target}`);
    }
  }
  const covered = (path: string) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  const requireReference = (reference: string, expected: string): void => {
    const parsed = parseComponentReference(reference);
    if (parsed.kind !== expected) throw new Error(`invalid ${expected} package reference: ${reference}`);
    if (parsed.source === "self" && !manifest.exports[parsed.kind]?.[parsed.exportName]) {
      throw new Error(`unresolved package reference: ${reference}`);
    }
    if (parsed.source === "dependency" && !manifest.dependencies?.[parsed.dependency]) {
      throw new Error(`undeclared package dependency reference: ${reference}`);
    }
    if (parsed.source === "installed") throw new Error(`installed alias is not portable inside a package: ${reference}`);
  };
  for (const path of Object.values(manifest.exports.agents ?? {})) {
    let agent: Record<string, unknown>;
    try { agent = JSON.parse(await readFile(join(absolute, path), "utf8")) as Record<string, unknown>; }
    catch { throw new Error(`invalid exported agent JSON: ${path}`); }
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error(`invalid exported agent: ${path}`);
    const tools = (agent.tools as { use?: unknown } | undefined)?.use;
    if (Array.isArray(tools)) for (const item of tools) {
      const reference = typeof item === "string" ? item : (item as { ref?: unknown } | undefined)?.ref;
      if (typeof reference !== "string") throw new Error(`invalid exported tool selection: ${path}`);
      if (reference.startsWith("#") || reference.startsWith("dep:")) requireReference(reference, "tools");
      else if (reference.startsWith("mcp/")) {
        const server = reference.split("/")[1];
        if (!server || !manifest.exports.mcp?.[server]) throw new Error(`unresolved package MCP selection: ${reference}`);
      } else if (!reference.startsWith("builtin/")) throw new Error(`nonportable exported tool selection: ${reference}`);
    }
    const skills = (agent.skills as { use?: unknown } | undefined)?.use;
    if (Array.isArray(skills)) for (const item of skills) {
      const reference = typeof item === "string" ? item : (item as { ref?: unknown } | undefined)?.ref;
      if (typeof reference !== "string") throw new Error(`invalid exported skill selection: ${path}`);
      if (reference.startsWith("#") || reference.startsWith("dep:")) requireReference(reference, "skills");
      else if (!reference.startsWith("builtin/")) throw new Error(`nonportable exported skill selection: ${reference}`);
    }
    const hooks = (agent.hooks as { use?: unknown } | undefined)?.use;
    if (Array.isArray(hooks)) for (const reference of hooks) {
      if (typeof reference !== "string") throw new Error(`invalid exported hook selection: ${path}`);
      requireReference(reference, "hooks");
    }
    if (Array.isArray(agent.vars)) for (const reference of agent.vars) {
      if (typeof reference !== "string") throw new Error(`invalid exported var selection: ${path}`);
      requireReference(reference, "vars");
    }
    if (typeof agent.system_prompt_file === "string" && !covered(packagePath(agent.system_prompt_file))) {
      throw new Error(`uncovered exported prompt file: ${agent.system_prompt_file}`);
    }
  }
  for (const path of Object.values(manifest.exports.vars ?? {})) {
    const variable = JSON.parse(await readFile(join(absolute, path), "utf8")) as { source?: { kind?: string; name?: unknown; path?: unknown } };
    if (variable.source?.kind === "provider" && typeof variable.source.name === "string"
      && variable.source.name !== "system.time" && !manifest.exports.var_providers?.[variable.source.name]) {
      throw new Error(`unresolved exported variable provider: ${variable.source.name}`);
    }
    if (variable.source?.kind === "file" && typeof variable.source.path === "string"
      && !covered(packagePath(variable.source.path))) throw new Error(`uncovered exported variable file: ${variable.source.path}`);
  }
  for (const [alias, dependency] of Object.entries(manifest.dependencies ?? {})) {
    const archive = files.get(dependency.archive);
    if (!archive) throw new Error(`missing dependency archive ${alias}: ${dependency.archive}`);
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (digest !== dependency.digest) throw new Error(`dependency archive digest mismatch: ${alias}`);
  }
  return { root: absolute, manifest, files: Object.freeze([...files.keys()].sort()) };
}
