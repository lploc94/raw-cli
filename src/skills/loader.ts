import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { packageRoot } from "../package-root.js";
import type { SelectedSkill } from "./contract.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import type { PackageAsset } from "../packages/resolve-agent.js";
import { HOST_CONTENT_BYTES } from "../tools/results.js";

export interface LoadSelectedSkillsOptions {
  selectedIds: readonly string[];
  configPath: string;
  /** @deprecated Ignored: skill bodies load whole, bounded only by a 1 MiB safety limit. */
  maxOutputBytes?: number;
  /** When set, a skill over the safety limit is skipped and reported here instead of failing. */
  onSkip?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  globalConfigRoot?: string;
  packageSkills?: Readonly<Record<string, PackageAsset>>;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix);
}

export async function loadSelectedSkills(options: LoadSelectedSkillsOptions): Promise<readonly SelectedSkill[]> {
  if (options.selectedIds.length === 0) return Object.freeze([]);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalBase = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  const roots = { builtin: join(packageRoot(), "dist", "skills", "builtin"),
    local: join(options.globalConfigRoot ?? join(globalBase, "raw"), "skills"),
    agent: join(dirname(resolve(cwd, options.configPath)), "skills") };
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const skills: SelectedSkill[] = [];
  for (const id of options.selectedIds) {
    const direct = options.packageSkills?.[id];
    const match = direct ? undefined : /^(builtin|local|agent)\/([a-z][a-z0-9_-]*)$/.exec(id);
    if (!direct && !match) throw new Error(`invalid skill id: ${id}`);
    if (seenIds.has(id)) throw new Error(`duplicate skill id: ${id}`);
    seenIds.add(id);
    const root = direct ? dirname(direct.folder) : roots[match![1] as "builtin" | "local" | "agent"];
    let realRoot: string;
    let realFolder: string;
    let realMarkdown: string;
    try {
      realRoot = await realpath(root);
      realFolder = await realpath(direct?.folder ?? join(root, match![2]!));
      realMarkdown = await realpath(join(realFolder, "SKILL.md"));
    } catch { throw new Error(`missing selected skill: ${id}`); }
    if (!inside(realRoot, realFolder) || !inside(realFolder, realMarkdown)) {
      throw new Error(`selected skill escapes folder: ${id}`);
    }
    if (!(await stat(realMarkdown)).isFile()) throw new Error(`invalid selected skill file: ${id}`);
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(realMarkdown)); }
    catch { throw new Error(`invalid UTF-8 selected skill: ${id}`); }
    const skill = parseSkillMarkdown(source, direct?.name ?? match![2]!, `selected skill ${id}/SKILL.md`);
    const visibleName = direct?.as ?? skill.name;
    if (seenNames.has(visibleName)) throw new Error(`duplicate skill name: ${visibleName}`);
    seenNames.add(visibleName);
    if (Buffer.byteLength(skill.markdown) > HOST_CONTENT_BYTES) {
      const message = `selected skill exceeds 1 MiB: ${id}`;
      if (!options.onSkip) throw new Error(message);
      options.onSkip(`${message}; skipped`);
      continue;
    }
    skills.push(Object.freeze({ id: direct ? `${direct.canonicalIdentity}:${visibleName}` : id,
      ...skill, name: visibleName }));
  }
  return Object.freeze(skills);
}
