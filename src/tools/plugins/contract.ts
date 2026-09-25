import type { ToolRegistration } from "../registry.js";

export interface ToolManifest {
  api_version: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  input_schema: ToolRegistration["inputSchema"];
  entry: "./index.mjs";
}

export interface ToolPlugin {
  id: string;
  version: string;
  registration: ToolRegistration;
}
