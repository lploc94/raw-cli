import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import type { SelectedSkill } from "./contract.js";

export interface LoadSelectedSkillsOptions {
  selectedIds: readonly string[];
  configPath: string;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  globalConfigRoot?: string;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix);
}

function checkDuplicates(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = getNodeValue(property.children?.[0]!);
      if (seen.has(key)) throw new Error(`duplicate skill manifest field: ${key}`);
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) checkDuplicates(child);
}

function parseManifest(bytes: Buffer, id: string, folder: string): Omit<SelectedSkill, "markdown"> {
  if (bytes.length > 64 * 1024) throw new Error(`skill manifest is too large: ${id}`);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`invalid UTF-8 skill manifest: ${id}`); }
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw new Error(`invalid skill manifest JSON: ${id}`);
  checkDuplicates(tree);
  const data: unknown = getNodeValue(tree);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`invalid skill manifest: ${id}`);
  const item = data as Record<string, unknown>;
  const fields = ["api_version", "id", "version", "name", "description"];
  if (Object.keys(item).length !== fields.length || Object.keys(item).some((key) => !fields.includes(key))
    || item.api_version !== 1 || item.id !== folder
    || typeof item.version !== "string" || !/^\d+\.\d+\.\d+$/.test(item.version)
    || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(item.name)
    || typeof item.description !== "string" || !item.description.trim()) {
    throw new Error(`invalid skill manifest: ${id}`);
  }
  return { id, version: item.version, name: item.name, description: item.description };
}

export async function loadSelectedSkills(options: LoadSelectedSkillsOptions): Promise<readonly SelectedSkill[]> {
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error("invalid skill output cap");
  if (options.selectedIds.length === 0) return Object.freeze([]);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalBase = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  const roots = { local: join(options.globalConfigRoot ?? join(globalBase, "raw"), "skills"),
    agent: join(dirname(resolve(cwd, options.configPath)), "skills") };
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const skills: SelectedSkill[] = [];
  for (const id of options.selectedIds) {
    const match = /^(local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (!match) throw new Error(`invalid skill id: ${id}`);
    if (seenIds.has(id)) throw new Error(`duplicate skill id: ${id}`);
    seenIds.add(id);
    const root = roots[match[1] as "local" | "agent"];
    let realRoot: string;
    let realFolder: string;
    let realManifest: string;
    let realMarkdown: string;
    try {
      realRoot = await realpath(root);
      realFolder = await realpath(join(root, match[2]!));
      realManifest = await realpath(join(realFolder, "skill.json"));
      realMarkdown = await realpath(join(realFolder, "SKILL.md"));
    } catch { throw new Error(`missing selected skill: ${id}`); }
    if (!inside(realRoot, realFolder) || !inside(realFolder, realManifest) || !inside(realFolder, realMarkdown)) {
      throw new Error(`selected skill escapes folder: ${id}`);
    }
    if (!(await stat(realManifest)).isFile() || !(await stat(realMarkdown)).isFile()) throw new Error(`invalid selected skill file: ${id}`);
    const manifest = parseManifest(await readFile(realManifest), id, match[2]!);
    if (seenNames.has(manifest.name)) throw new Error(`duplicate skill name: ${manifest.name}`);
    seenNames.add(manifest.name);
    const markdownSize = (await stat(realMarkdown)).size;
    if (markdownSize > options.maxOutputBytes) throw new Error(`selected skill exceeds max_output_bytes: ${id}`);
    let markdown: string;
    try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(realMarkdown)); }
    catch { throw new Error(`invalid UTF-8 selected skill: ${id}`); }
    if (Buffer.byteLength(markdown) > options.maxOutputBytes) throw new Error(`selected skill exceeds max_output_bytes: ${id}`);
    skills.push(Object.freeze({ ...manifest, markdown }));
  }
  const catalog = { skills: skills.map(({ name, description }) => ({ name, description })) };
  if (Buffer.byteLength(JSON.stringify(catalog)) > options.maxOutputBytes) throw new Error("selected skill catalog exceeds max_output_bytes");
  return Object.freeze(skills);
}
