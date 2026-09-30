import type { PanelDeclaration } from "../../panels/contract.js";
import type { ToolRegistration } from "../registry.js";
import type { ConditionSource } from "../policy.js";

export interface ToolManifest {
  api_version: 2;
  id: string;
  version: string;
  name: string;
  description: string;
  input_schema: ToolRegistration["inputSchema"];
  entry: "./index.mjs";
  condition_sources?: ConditionSource[];
  effects_schema?: Readonly<Record<string, unknown>>;
  panels?: PanelDeclaration[];
}

export interface ToolPlugin {
  id: string;
  version: string;
  sourceDigest: string;
  registration: ToolRegistration;
}
