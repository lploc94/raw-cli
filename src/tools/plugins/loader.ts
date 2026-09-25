import Ajv from "ajv";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolRegistration } from "../registry.js";
import type { ToolManifest, ToolPlugin } from "./contract.js";

const bundledNames = new Set(["read_file", "write_file", "bash", "view_image"]);

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Raw package root not found");
    directory = parent;
  }
}

export function bundledToolsRoot(): string {
  return join(packageRoot(), "dist", "tools", "builtin");
}

function manifestFrom(value: unknown, expectedName: string): ToolManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid bundled tool manifest: ${expectedName}`);
  const item = value as Record<string, unknown>;
  const keys = ["api_version", "id", "version", "name", "description", "input_schema", "entry"];
  if (Object.keys(item).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(item, key))
    || item.api_version !== 1 || item.id !== expectedName || item.name !== expectedName
    || typeof item.version !== "string" || !item.version || typeof item.description !== "string"
    || item.entry !== "./index.mjs" || !item.input_schema || typeof item.input_schema !== "object") {
    throw new Error(`invalid bundled tool manifest: ${expectedName}`);
  }
  return item as unknown as ToolManifest;
}

async function loadBundled(name: string): Promise<ToolPlugin> {
  if (!bundledNames.has(name)) throw new Error(`unknown bundled tool: ${name}`);
  const folder = resolve(bundledToolsRoot(), name);
  const manifest = manifestFrom(JSON.parse(await readFile(join(folder, "tool.json"), "utf8")), name);
  const entry = await import(pathToFileURL(join(folder, manifest.entry)).href) as {
    handler?: unknown; validateArgs?: unknown;
  };
  if (typeof entry.handler !== "function" || (entry.validateArgs !== undefined && typeof entry.validateArgs !== "function")) {
    throw new Error(`invalid bundled tool entry: ${name}`);
  }
  const ajv = new Ajv.default({ allErrors: true, strict: false });
  const schema = ajv.compile(manifest.input_schema);
  const semantic = entry.validateArgs as ((args: unknown) => string | undefined) | undefined;
  const registration: ToolRegistration = {
    name: manifest.name,
    description: manifest.description,
    inputSchema: manifest.input_schema,
    validateArgs(args) {
      const error = semantic?.(args);
      if (error) return error;
      return schema(args) ? undefined : `invalid arguments: ${ajv.errorsText(schema.errors)}`;
    },
    handler: entry.handler as ToolRegistration["handler"],
  };
  return { id: `builtin/${name}`, version: manifest.version, registration };
}

export async function loadBundledTools(names: readonly string[]): Promise<ToolRegistration[]> {
  if (new Set(names).size !== names.length) throw new Error("duplicate bundled tool selection");
  const selected = await Promise.all(names.map(loadBundled));
  return selected.map((plugin) => plugin.registration);
}
