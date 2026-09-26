import { canonicalConfigPath, configFilePath, parseConfigSource, type LoadConfigOptions } from "../config.js";
import { withPackageWriteLock } from "../packages/lock.js";
import { assertRevision, ManagementError, publishText, readText, type TextSnapshot } from "./files.js";
import { createStarterConfig } from "./starter.js";

export interface ManagedConfig extends TextSnapshot {
  path: string;
  canonical: boolean;
  data?: Record<string, unknown>;
  diagnostic?: string;
}
export type ConfigEditOptions = LoadConfigOptions & { expectedRevision?: string };
export async function readManagedConfig(options: LoadConfigOptions = {}): Promise<ManagedConfig> {
  const path = configFilePath(options);
  const snapshot = await readText(path);
  const result: ManagedConfig = { ...snapshot, path, canonical: path === canonicalConfigPath(options) };
  if (!snapshot.exists) return result;
  try { result.data = parseConfigSource(snapshot.source, { ...options, configPath: path }).data; }
  catch (error) { result.diagnostic = error instanceof Error ? error.message : String(error); }
  return result;
}
export async function mutateConfig(options: ConfigEditOptions,
  change: (data: Record<string, unknown>) => void | Promise<void>): Promise<ManagedConfig> {
  const path = configFilePath(options);
  return withPackageWriteLock(path, async () => {
    const current = await readManagedConfig(options); assertRevision(options.expectedRevision, current);
    if (!current.exists) throw new ManagementError("not_found", "config does not exist; initialize it first");
    if (!current.data) throw new ManagementError("invalid_input", current.diagnostic ?? "invalid config");
    const data = structuredClone(current.data); await change(data);
    const source = JSON.stringify(data, null, 2) + "\n";
    parseConfigSource(source, { ...options, configPath: path });
    const saved = await publishText(path, source, current);
    return { ...saved, path, canonical: current.canonical, data };
  });
}
export async function saveConfigText(options: ConfigEditOptions, source: string): Promise<ManagedConfig> {
  const path = configFilePath(options);
  return withPackageWriteLock(path, async () => {
    const original = await readText(path); assertRevision(options.expectedRevision, original);
    const data = parseConfigSource(source, { ...options, configPath: path }).data;
    const saved = await publishText(path, source, original);
    return { ...saved, path, canonical: path === canonicalConfigPath(options), data };
  });
}
export async function initializeConfig(options: LoadConfigOptions = {}): Promise<ManagedConfig> {
  const path = configFilePath(options);
  return withPackageWriteLock(path, async () => {
    const current = await readText(path);
    if (current.exists) throw new ManagementError("conflict", "config already exists");
    const data = createStarterConfig(); const source = JSON.stringify(data, null, 2) + "\n";
    parseConfigSource(source, { ...options, configPath: path });
    const saved = await publishText(path, source, current);
    return { ...saved, path, canonical: path === canonicalConfigPath(options), data };
  });
}
