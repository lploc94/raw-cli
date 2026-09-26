import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configFilePath, readConfigDocument, validateEffectiveConfigData } from "../config.js";
import { packPackage } from "./archive.js";
import { exportAgentPackage } from "./export.js";
import { inspectPackage, validatePackage } from "./inspect.js";
import { parseComponentReference } from "./references.js";
import { createPackageResolutionContext, resolvePackageAgentBinding, resolvePackageDefinitions,
  resolvePackageSelections } from "./resolve-agent.js";
import { withPackageWriteLock } from "./lock.js";
import { forkPackage, installPackage, linkPackage, listInstalledPackages, removePackage, updatePackage } from "./store.js";

function args(argv: readonly string[]): { words: string[]; options: Record<string, string> } {
  const words: string[] = [];
  const options: Record<string, string> = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    if (!["--config", "--as", "--from", "--out", "--agent", "--name", "--version", "--model", "--inputs"].includes(arg)) {
      throw new Error(`unknown package option ${arg}`);
    }
    if (options[arg]) throw new Error(`duplicate package option ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[arg] = value;
  }
  return { words, options };
}

function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exact(words: string[], count: number): void {
  if (words.length !== count) throw new Error("invalid package command arguments");
}

function allowedOptions(options: Record<string, string>, allowed: readonly string[]): void {
  for (const key of Object.keys(options)) if (key !== "--config" && !allowed.includes(key)) {
    throw new Error(`${key} is not valid for this command`);
  }
}

export interface AddPackageAgentOptions { configPath: string; name: string; from: string; model: string;
  inputs?: Readonly<Record<string, unknown>> }

export async function addPackageAgent(options: AddPackageAgentOptions): Promise<{ agent: string; binding: Record<string, unknown> }> {
  const { name, from, model, configPath } = options;
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid agent name: ${name}`);
  const parsed = parseComponentReference(from);
  if (parsed.source !== "installed" || parsed.kind !== "agents") throw new Error(`agent --from requires installed agent export: ${from}`);
  const inputs = options.inputs ?? {};
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("agent inputs must be a JSON object");
  const binding = { from, model, ...(Object.keys(inputs).length ? { inputs } : {}) };
  return withPackageWriteLock(configPath, async () => {
    const document = readConfigDocument({ configPath });
    const agents = (document.data.agents ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(agents, name)) throw new Error(`agent already exists: ${name}`);
    const models = (document.data.models ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(models, model)) throw new Error(`unknown model: ${model}`);
    const context = createPackageResolutionContext();
    const agent = await resolvePackageAgentBinding(binding, { configPath }, context);
    const selected = await resolvePackageSelections(agent, { configPath }, context);
    const { mcpIdentities: _mcpIdentities, mcpSources: _mcpSources, ...definitions } = await resolvePackageDefinitions(selected.agent,
      document.data, { configPath }, parsed.alias, context, inputs as Record<string, unknown>);
    validateEffectiveConfigData({ ...document.data, ...definitions,
      agents: { [name]: selected.agent }, default_agent: name });
    const updated = { ...document.data, agents: { ...agents, [name]: binding } };
    const stage = `${configPath}.tmp-${randomUUID()}`;
    await mkdir(dirname(configPath), { recursive: true });
    try {
      await writeFile(stage, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(stage, configPath);
    } catch (error) { await rm(stage, { force: true }); throw error; }
    return { agent: name, binding };
  });
}

export async function runPackageCli(argv: readonly string[]): Promise<boolean> {
  if (argv[0] !== "package" && argv[0] !== "agent") return false;
  const { words, options } = args(argv);
  const configPath = configFilePath({ ...(options["--config"] ? { configPath: options["--config"] } : {}) });
  const store = { configPath };
  let result: unknown;
  if (words[0] === "agent") {
    if (words[1] !== "add") throw new Error("agent requires add NAME");
    exact(words, 3);
    allowedOptions(options, ["--from", "--model", "--inputs"]);
    const inputs = options["--inputs"] === undefined ? {} : JSON.parse(await readFile(resolve(options["--inputs"]), "utf8")) as Record<string, unknown>;
    result = await addPackageAgent({ configPath, name: words[2]!, from: required(options, "--from"),
      model: required(options, "--model"), inputs });
  } else {
    const action = words[1];
    const accepted: Record<string, readonly string[]> = {
      list: [], inspect: [], validate: [], pack: ["--out"],
      export: ["--agent", "--name", "--version", "--out"],
      install: ["--as"], link: ["--as"], update: ["--from"], remove: [], fork: ["--out"],
    };
    if (action && Object.hasOwn(accepted, action)) allowedOptions(options, accepted[action]!);
    switch (action) {
      case "list": exact(words, 2); result = listInstalledPackages(store); break;
      case "inspect": exact(words, 3); result = await inspectPackage(words[2]!); break;
      case "validate": exact(words, 3); result = await validatePackage(words[2]!); break;
      case "pack": exact(words, 3); result = await packPackage(words[2]!, required(options, "--out")); break;
      case "export": exact(words, 2); result = await exportAgentPackage({ configPath,
        agentName: required(options, "--agent"), name: required(options, "--name"),
        version: required(options, "--version"), out: required(options, "--out") }); break;
      case "install":
      case "link": {
        exact(words, 3);
        const alias = options["--as"] ?? (await inspectPackage(words[2]!)).name.split("/").at(-1)!;
        result = action === "install" ? await installPackage({ ...store, source: words[2]!, alias })
          : await linkPackage({ ...store, source: words[2]!, alias });
        break;
      }
      case "update": exact(words, 3); result = await updatePackage({ ...store, alias: words[2]!,
        source: required(options, "--from") }); break;
      case "remove": exact(words, 3); await removePackage({ ...store, alias: words[2]! }); result = { removed: words[2] }; break;
      case "fork": exact(words, 3); result = { path: await forkPackage({ ...store, alias: words[2]!,
        out: required(options, "--out") }) }; break;
      default: throw new Error("package requires list, inspect, validate, pack, export, install, update, remove, link or fork");
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return true;
}
