import type { PanelDeclaration } from "../../panels/contract.js";
import type { ToolRegistration } from "../registry.js";

export interface ToolManifest {
  api_version: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  input_schema: ToolRegistration["inputSchema"];
  entry: "./index.mjs";
  panels?: PanelDeclaration[];
}

export interface ToolPlugin {
  id: string;
  version: string;
  sourceDigest: string;
  registration: ToolRegistration;
}
