import Ajv2020 from "ajv/dist/2020.js";
import { isAbsolute, resolve } from "node:path";
import { deepFreeze } from "./contract.js";

export interface InputSchema { type: "object"; properties: Record<string, Record<string, unknown>>; required?: readonly string[] }
const types = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const kinds = new Set(["file", "directory", "env-name", "var-source"]);
const propertyKeys = new Set(["type", "enum", "default", "description", "x-raw-kind"]);

export function parseInputSchema(value: unknown): InputSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid package inputs schema");
  const schema = value as Record<string, unknown>;
  if (Object.keys(schema).some((key) => !["type", "properties", "required"].includes(key)) || schema.type !== "object"
    || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error("unsupported package inputs schema or condition");
  }
  const properties = schema.properties as Record<string, unknown>;
  for (const [name, raw] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`invalid package input: ${name}`);
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !propertyKeys.has(key)) || !types.has(String(item.type))
      || (item["x-raw-kind"] !== undefined && !kinds.has(String(item["x-raw-kind"])))) {
      throw new Error(`unsupported package input property: ${name}`);
    }
    if (item.enum !== undefined && (!Array.isArray(item.enum) || item.enum.length === 0)) throw new Error(`invalid package input enum: ${name}`);
    if (item.description !== undefined && typeof item.description !== "string") throw new Error(`invalid package input description: ${name}`);
    if (item["x-raw-kind"] === "env-name" && item.type !== "string") throw new Error(`env-name input must be a string: ${name}`);
    if ((item["x-raw-kind"] === "file" || item["x-raw-kind"] === "directory") && item.type !== "string") {
      throw new Error(`path input must be a string: ${name}`);
    }
    if (item["x-raw-kind"] === "var-source" && item.type !== "object") throw new Error(`var-source input must be an object: ${name}`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name)))) {
    throw new Error("invalid package required inputs");
  }
  const parsed = { type: "object" as const, properties: properties as Record<string, Record<string, unknown>>,
    ...(schema.required === undefined ? {} : { required: schema.required as string[] }) };
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  try { ajv.compile({ ...parsed, additionalProperties: false }); }
  catch { throw new Error("invalid package input constraints"); }
  return deepFreeze(structuredClone(parsed));
}

function resolvedInputs(schema: InputSchema, supplied: Readonly<Record<string, unknown>>,
  recipientConfigDir?: string): Record<string, unknown> {
  const values = structuredClone(supplied) as Record<string, unknown>;
  const ajv = new Ajv2020.default({ strict: false, allErrors: true, useDefaults: true });
  const check = ajv.compile({ ...schema, additionalProperties: false });
  if (!check(values)) throw new Error(`invalid or missing package input: ${ajv.errorsText(check.errors)}`);
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = values[name];
    if (value === undefined) continue;
    if (property["x-raw-kind"] === "env-name" && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      throw new Error(`invalid env-name package input: ${name}`);
    }
    if ((property["x-raw-kind"] === "file" || property["x-raw-kind"] === "directory")
      && (typeof value !== "string" || !value || value.includes("\0"))) throw new Error(`invalid path package input: ${name}`);
    if (property["x-raw-kind"] === "file" || property["x-raw-kind"] === "directory") {
      if (!recipientConfigDir || !isAbsolute(recipientConfigDir)) throw new Error(`recipient config directory required for package input: ${name}`);
      values[name] = resolve(recipientConfigDir, value as string);
    }
  }
  return values;
}

export function applyPackageInputs<T>(definition: T, schema: InputSchema,
  supplied: Readonly<Record<string, unknown>>, allowedSites: readonly string[], recipientConfigDir?: string): T {
  const values = resolvedInputs(schema, supplied, recipientConfigDir);
  const allowed = new Set(allowedSites);
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      if (/\$\{[^}]*\}/.test(value)) throw new Error(`unsupported package interpolation: ${path}`);
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, "$input")) {
      if (Object.keys(object).length !== 1 || typeof object.$input !== "string") throw new Error(`invalid package input reference: ${path}`);
      if (!allowed.has(path)) throw new Error(`package input is not allowed at site: ${path}`);
      if (!Object.hasOwn(values, object.$input)) throw new Error(`missing package input: ${object.$input}`);
      return structuredClone(values[object.$input]);
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, walk(item, path ? `${path}.${key}` : key)]));
  };
  return walk(definition, "") as T;
}
