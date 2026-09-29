import AjvDraft7 from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { PANEL_LIMITS } from "../../panels/contract.js";
import { validateDeclaration } from "../../panels/validate.js";
import type { ToolManifest } from "./contract.js";

const manifestKeys = ["api_version", "id", "version", "name", "description", "input_schema", "entry"];
const optionalKeys = ["panels"];

export function parseToolManifest(value: unknown, expectedId: string, expectedFolder: string, warn?: (message: string) => void): ToolManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid tool manifest: ${expectedId}`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !manifestKeys.includes(key) && !optionalKeys.includes(key))
    || manifestKeys.some((key) => !Object.hasOwn(item, key))
    || item.api_version !== 1 || item.id !== expectedFolder
    || typeof item.version !== "string" || !/^\d+\.\d+\.\d+$/.test(item.version)
    || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(item.name)
    || typeof item.description !== "string" || !item.description.trim()
    || item.entry !== "./index.mjs" || !item.input_schema || typeof item.input_schema !== "object"
    || Array.isArray(item.input_schema)) throw new Error(`invalid tool manifest: ${expectedId}`);
  if (item.panels !== undefined) {
    try {
      if (!Array.isArray(item.panels) || item.panels.length > PANEL_LIMITS.panelsPerTool) throw new Error("panels");
      const declared = item.panels.map((panel, index) => validateDeclaration(panel, `panels[${index}]`, warn));
      if (new Set(declared.map((panel) => panel.id)).size !== declared.length) throw new Error("duplicate panel id");
      item.panels = declared;
    } catch { throw new Error(`invalid tool manifest: ${expectedId}`); }
  }
  return item as unknown as ToolManifest;
}

function checkSchemaReferences(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) checkSchemaReferences(item); return; }
  const record = value as Record<string, unknown>;
  if (record.$async !== undefined) throw new Error("async tool schema is unsupported");
  if (record.$ref !== undefined && (typeof record.$ref !== "string" || !record.$ref.startsWith("#/"))) {
    throw new Error("remote tool schema reference is unsupported");
  }
  for (const item of Object.values(record)) checkSchemaReferences(item);
}

export function compileToolSchema(manifest: ToolManifest): (args: unknown) => string | undefined {
  checkSchemaReferences(manifest.input_schema);
  if (manifest.input_schema.type !== "object") throw new Error(`unsupported tool schema: ${manifest.name}`);
  const declared = manifest.input_schema.$schema;
  const draft7 = typeof declared === "string" && /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(declared);
  if (declared !== undefined && !draft7 && declared !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error(`unsupported tool schema draft: ${manifest.name}`);
  }
  const ajv = draft7 ? new AjvDraft7.default({ strict: true, allErrors: true }) : new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  let validate: ReturnType<typeof ajv.compile>;
  try { validate = ajv.compile(manifest.input_schema); }
  catch { throw new Error(`unsupported tool schema: ${manifest.name}`); }
  if ((validate as typeof validate & { $async?: boolean }).$async) throw new Error(`async tool schema is unsupported: ${manifest.name}`);
  return (args) => validate(args) ? undefined : `invalid arguments: ${ajv.errorsText(validate.errors)}`;
}
