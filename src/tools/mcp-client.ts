import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { ToolRegistry, createToolRegistry, type ToolRegistration } from "./registry.js";
import { capResult, errorResult } from "./results.js";
import type { ToolContent, ToolResult } from "./types.js";

const MAX_MCP_BYTES = 16 * 1024 * 1024;
type Selection = "*" | readonly string[];

export type McpServerConfig =
  | { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; tools?: Selection }
  | { url: string; transport?: "sse" | "streamable-http"; headers?: Readonly<Record<string, string>>; tools?: Selection };

export interface McpConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface ConnectMcpOptions extends McpConfigOptions {
  servers?: Readonly<Record<string, McpServerConfig>>;
  registry?: ToolRegistry;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpToolInfo {
  server: string;
  originalName: string;
  alias: string;
}

export interface McpConnection {
  readonly registry: ToolRegistry;
  readonly discovered: readonly { server: string; name: string }[];
  readonly catalog: readonly McpToolInfo[];
  readonly exposed: readonly McpToolInfo[];
  activate(aliases: readonly string[]): void;
  close(): Promise<void>;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${where} field: ${key}`);
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a nonempty string`);
  return value;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${where} must be a string array`);
  return value;
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const data = record(value, where);
  for (const [key, item] of Object.entries(data)) {
    if (!key || typeof item !== "string") throw new Error(`${where} must contain string values`);
  }
  return data as Record<string, string>;
}

function validateServer(name: string, raw: unknown): McpServerConfig {
  const data = record(raw, `MCP server ${name}`);
  const hasCommand = Object.hasOwn(data, "command");
  const hasUrl = Object.hasOwn(data, "url");
  if (hasCommand === hasUrl) throw new Error(`MCP server ${name} requires exactly one transport form`);
  let tools: Selection | undefined;
  if (data.tools !== undefined) {
    tools = data.tools === "*" ? "*" : strings(data.tools, `MCP server ${name}.tools`);
    if (tools !== "*" && (tools.some((tool) => !tool.trim()) || new Set(tools).size !== tools.length)) {
      throw new Error(`MCP server ${name}.tools contains an empty or duplicate name`);
    }
  }
  if (hasCommand) {
    checkKeys(data, ["command", "args", "env", "tools"], `MCP server ${name}`);
    return { command: string(data.command, `MCP server ${name}.command`),
      ...(data.args !== undefined ? { args: strings(data.args, `MCP server ${name}.args`) } : {}),
      ...(data.env !== undefined ? { env: stringMap(data.env, `MCP server ${name}.env`) } : {}),
      ...(tools !== undefined ? { tools } : {}) };
  }
  checkKeys(data, ["url", "transport", "headers", "tools"], `MCP server ${name}`);
  const url = string(data.url, `MCP server ${name}.url`);
  try { if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("protocol"); }
  catch { throw new Error(`MCP server ${name}.url must be HTTP(S)`); }
  const transport = data.transport === undefined ? "sse" : data.transport;
  if (transport !== "sse" && transport !== "streamable-http") throw new Error(`MCP server ${name}.transport is unsupported`);
  return { url, transport,
    ...(data.headers !== undefined ? { headers: stringMap(data.headers, `MCP server ${name}.headers`) } : {}),
    ...(tools !== undefined ? { tools } : {}) };
}

function duplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0] && getNodeValue(property.children[0]);
      if (typeof key !== "string" || seen.has(key)) throw new Error("duplicate or invalid MCP config key");
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) duplicateKeys(child);
}

function readMcpFile(path: string): Record<string, McpServerConfig> {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`cannot read MCP config: ${path}`); }
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length) throw new Error(`invalid MCP JSON config: ${path}`);
  duplicateKeys(tree);
  const root = record(getNodeValue(tree), "MCP config");
  checkKeys(root, ["mcpServers"], "MCP config");
  const servers = root.mcpServers === undefined ? {} : record(root.mcpServers, "mcpServers");
  return Object.fromEntries(Object.entries(servers).map(([name, value]) => [string(name, "MCP server name"), validateServer(name, value)]));
}

export function loadMcpConfig(options: McpConfigOptions = {}): Record<string, McpServerConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const base = env.XDG_CONFIG_HOME ? resolve(cwd, env.XDG_CONFIG_HOME) : join(options.home ?? homedir(), ".config");
  return { ...readMcpFile(join(base, "raw", "mcp.json")), ...readMcpFile(join(cwd, "raw-mcp.json")) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function aliasFor(server: string, tool: string): string {
  const prefix = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 47);
  const suffix = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${prefix}_${suffix}`;
}

async function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.body) return response;
  const sse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  const length = Number(response.headers.get("content-length"));
  if (!sse && Number.isFinite(length) && length > MAX_MCP_BYTES) {
    await response.body.cancel();
    throw new Error("MCP message exceeds 16 MiB");
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let lineBytes = 0;
  let afterCR = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        const chunk = next.value;
        if (!sse) bytes += chunk.byteLength;
        else for (const byte of chunk) {
          bytes++;
          if (byte === 13) {
            if (lineBytes === 0) bytes = 0;
            lineBytes = 0;
            afterCR = true;
          } else if (byte === 10) {
            if (!afterCR && lineBytes === 0) bytes = 0;
            lineBytes = 0;
            afterCR = false;
          } else { lineBytes++; afterCR = false; }
          if (bytes > MAX_MCP_BYTES) break;
        }
        if (bytes > MAX_MCP_BYTES) {
          await reader.cancel();
          controller.error(new Error("MCP message exceeds 16 MiB"));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function decodedImage(data: string): number {
  if (data.length % 4 !== 0 || data.length > Math.ceil(MAX_MCP_BYTES * 4 / 3) + 4) throw new Error("invalid image base64 or image too large");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if ((data.length / 4) * 3 - padding > MAX_MCP_BYTES) throw new Error("image exceeds 16 MiB");
  for (let index = 0; index < data.length - padding; index++) {
    const code = data.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      throw new Error("invalid image base64");
    }
  }
  for (let index = data.length - padding; index < data.length; index++) if (data[index] !== "=") throw new Error("invalid image base64");
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) throw new Error("invalid image base64");
  return decoded.length;
}

export function mcpResultToToolResult(raw: unknown, maxOutputBytes: number): ToolResult {
  try {
    const result = record(raw, "MCP result");
    const blocks = Array.isArray(result.content) ? result.content : [];
    const content: ToolContent[] = [];
    let decodedBytes = Buffer.byteLength(JSON.stringify({ ...result, content: [], structuredContent: undefined }));
    if (decodedBytes > MAX_MCP_BYTES) return errorResult("result_too_large", "MCP result exceeds 16 MiB");
    let structured: unknown;
    if (result.structuredContent !== undefined) {
      structured = result.structuredContent;
      decodedBytes += Buffer.byteLength(JSON.stringify(structured));
      content.push({ type: "json", value: structured });
    }
    for (const rawBlock of blocks) {
      const block = record(rawBlock, "MCP content block");
      if (block.type === "text" && typeof block.text === "string") {
        decodedBytes += Buffer.byteLength(block.text);
        let duplicate = false;
        if (structured !== undefined) {
          try { duplicate = JSON.stringify(canonical(JSON.parse(block.text))) === JSON.stringify(canonical(structured)); }
          catch { /* preserve non-JSON text */ }
        }
        if (!duplicate) content.push({ type: "text", text: block.text });
      } else if (block.type === "image" && (block.mimeType === "image/png" || block.mimeType === "image/jpeg") && typeof block.data === "string") {
        decodedBytes += decodedImage(block.data);
        content.push({ type: "image", mimeType: block.mimeType, data: block.data });
      } else return errorResult("unsupported_content", `unsupported MCP content: ${String(block.type)}`);
      if (decodedBytes > MAX_MCP_BYTES) return errorResult("result_too_large", "MCP result exceeds 16 MiB");
    }
    if (decodedBytes > MAX_MCP_BYTES) return errorResult("result_too_large", "MCP result exceeds 16 MiB");
    return capResult({ isError: result.isError === true, content, ...(result.isError === true ? { code: "mcp_error" } : {}) }, maxOutputBytes);
  } catch (error) { return errorResult("unsupported_content", `invalid MCP result: ${(error as Error).message}`); }
}

async function deadline<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP operation timed out")), timeoutMs);
      if (signal) {
        onAbort = () => reject(new Error("MCP operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
    return await Promise.race([work, stopped]);
  } finally { if (timer) clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}

export async function connectMcpServers(options: ConnectMcpOptions = {}): Promise<McpConnection> {
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error("MCP timeout must be a positive integer");
  const configs = options.servers ?? loadMcpConfig(options);
  const specs = Object.entries(configs).map(([name, raw]) => [string(name, "MCP server name"), validateServer(name, raw)] as const).sort(([a], [b]) => a.localeCompare(b));
  const registry = options.registry ?? createToolRegistry();
  const owners: Client[] = [];
  const discovered: { server: string; name: string }[] = [];
  const exposed: McpToolInfo[] = [];
  const catalogInfo: McpToolInfo[] = [];
  const available = new Map<string, () => ToolRegistration>();
  const selectedAliases: string[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(owners.reverse().map((client) => client.close()));
  };
  try {
    for (const [name, spec] of specs) {
      if (options.signal?.aborted) throw new Error("MCP startup aborted");
      const client = new Client({ name: "raw-cli", version: "0.1.0" }, { capabilities: {} });
      owners.push(client);
      const transport = "command" in spec
        ? new StdioClientTransport({ command: spec.command, args: [...(spec.args ?? [])],
          env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...spec.env },
          cwd: options.cwd ?? process.cwd(), stderr: "pipe", maxBufferSize: MAX_MCP_BYTES })
        : spec.transport === "streamable-http"
          ? new StreamableHTTPClientTransport(new URL(spec.url), { ...(spec.headers ? { requestInit: { headers: { ...spec.headers } } } : {}),
            fetch: boundedFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
          : new SSEClientTransport(new URL(spec.url), { ...(spec.headers ? { requestInit: { headers: { ...spec.headers } },
            eventSourceInit: { fetch: (url, init) => {
              const headers = new Headers(init.headers as HeadersInit);
              for (const [key, value] of Object.entries(spec.headers ?? {})) headers.set(key, value);
              return boundedFetch(url, { ...init, headers } as RequestInit);
            } } } : { eventSourceInit: { fetch: (url, init) => boundedFetch(url, init as RequestInit) } }),
            fetch: boundedFetch });
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
      if (transport instanceof SSEClientTransport || transport instanceof StreamableHTTPClientTransport) {
        transport.onerror = () => { void close(); };
      }
      try {
        await deadline(client.connect(transport as unknown as Transport,
          { timeout: timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }), timeoutMs, options.signal);
      } catch { throw new Error(`MCP server ${name} connection failed`); }
      const catalog = new Map<string, { description: string; inputSchema: ToolRegistration["inputSchema"] }>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        let page;
        try { page = await deadline(client.listTools(cursor ? { cursor } : undefined,
          { timeout: timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }), timeoutMs, options.signal); }
        catch { throw new Error(`MCP server ${name} discovery failed`); }
        for (const tool of page.tools) {
          if (catalog.has(tool.name)) throw new Error(`duplicate MCP tool ${tool.name} from ${name}`);
          catalog.set(tool.name, { description: tool.description ?? "MCP tool", inputSchema: tool.inputSchema as ToolRegistration["inputSchema"] });
          discovered.push({ server: name, name: tool.name });
        }
        cursor = page.nextCursor;
        if (cursor) { if (cursors.has(cursor)) throw new Error(`MCP pagination cycle from ${name}`); cursors.add(cursor); }
      } while (cursor);
      const selected = spec.tools === "*" ? [...catalog.keys()] : spec.tools ?? [];
      for (const originalName of selected) if (!catalog.has(originalName)) throw new Error(`unknown MCP tool ${originalName} selected from ${name}`);
      for (const [originalName, tool] of catalog) {
        const alias = aliasFor(name, originalName);
        if (available.has(alias)) throw new Error(`duplicate MCP alias: ${alias}`);
        catalogInfo.push({ server: name, originalName, alias });
        available.set(alias, () => {
          const schema = canonical(tool.inputSchema) as ToolRegistration["inputSchema"];
          const ajv = new Ajv2020.default({ strict: true, allErrors: true });
          addFormats.default(ajv);
          let validate: ReturnType<typeof ajv.compile>;
          try { validate = ajv.compile(schema); }
          catch { throw new Error(`unsupported MCP tool schema for ${name}/${originalName}`); }
          if ((validate as typeof validate & { $async?: boolean }).$async) throw new Error(`unsupported async MCP tool schema for ${name}/${originalName}`);
          return { name: alias, description: tool.description, inputSchema: schema,
          validateArgs: (args) => validate(args) ? undefined : ajv.errorsText(validate.errors),
          handler: async (args, context) => {
            if (closed) return errorResult("mcp_closed", `MCP server ${name} is closed`);
            try {
              const response = await client.callTool({ name: originalName, arguments: args }, undefined,
                { timeout: timeoutMs, ...(context.signal ? { signal: context.signal } : {}) });
              if (context.signal?.aborted) return errorResult("aborted", "MCP call aborted");
              return mcpResultToToolResult(response, context.maxOutputBytes);
            } catch (error) {
              if (context.signal?.aborted) return errorResult("aborted", "MCP call aborted");
              const timedOut = /timeout|timed out/i.test((error as Error).message);
              return errorResult("mcp_call_error", timedOut ? `MCP call timed out: ${name}` : `MCP call failed: ${name}`);
            }
          } };
        });
        if (selected.includes(originalName)) selectedAliases.push(alias);
      }
    }
    const activated = new Set<string>();
    const activate = (aliases: readonly string[]) => {
      const existing = new Set(registry.definitions().map((item) => item.name));
      const unique = [...new Set(aliases)];
      for (const alias of unique) {
        if (!available.has(alias) && !existing.has(alias)) throw new Error(`unknown MCP alias: ${alias}`);
        if (available.has(alias) && existing.has(alias) && !activated.has(alias)) throw new Error(`duplicate MCP alias: ${alias}`);
      }
      const registrations = unique.filter((alias) => available.has(alias) && !activated.has(alias)).map((alias) => available.get(alias)!());
      for (const registration of registrations) { registry.register(registration); activated.add(registration.name); }
      for (const registration of registrations) exposed.push(catalogInfo.find((item) => item.alias === registration.name)!);
      exposed.sort((a, b) => a.alias.localeCompare(b.alias));
    };
    activate(selectedAliases);
    catalogInfo.sort((a, b) => a.alias.localeCompare(b.alias));
    return { registry, discovered, catalog: catalogInfo, exposed, activate, close };
  } catch (error) { await close(); throw error; }
}
