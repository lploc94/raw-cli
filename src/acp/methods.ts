import { randomUUID, createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { agent, PROTOCOL_VERSION, RequestError, type AgentApp, type AgentConnection,
  type AgentContext, type ContentBlock, type McpServer, type SessionUpdate } from "@agentclientprotocol/sdk";
import { createAgent, type AgentSession, type RunEvent } from "../agent.js";
import type { RuntimeConfig } from "../config.js";
import { createProvider } from "../llm/client.js";
import type { ProviderAdapter, ProviderProfile, UserBlock } from "../llm/types.js";
import { connectMcpServers, type McpConnection, type McpServerConfig } from "../tools/mcp-client.js";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.js";
import { capResult, errorResult } from "../tools/results.js";
import type { ToolContent, ToolResult } from "../tools/types.js";
import { fields, object, rawCapabilities, rawError, rawErrors, string, stringArray, withAbort,
  type RawCapabilities, type RawCapability } from "./rpc.js";

export interface AcpServerOptions {
  runtime: RuntimeConfig;
  providerFactory?: (profile: Readonly<ProviderProfile>) => ProviderAdapter;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

interface SessionRecord {
  id: string;
  agent: AgentSession;
  registry: ToolRegistry;
  mcp: McpConnection;
  registered: Map<string, string>;
}

export interface AcpServer {
  app: AgentApp;
  close(): Promise<void>;
}

function sessionMcpServers(requestServers: readonly McpServer[], configured: Readonly<Record<string, McpServerConfig>>): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = Object.assign(Object.create(null), configured);
  for (const server of requestServers) {
    const selection = configured[server.name]?.tools ?? "*";
    if ("command" in server) {
      merged[server.name] = { command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map((item) => [item.name, item.value])), tools: selection };
    } else {
      if (server.type === "acp") throw RequestError.invalidParams(undefined, "ACP MCP transport is unsupported");
      merged[server.name] = { url: server.url, transport: server.type === "http" ? "streamable-http" : "sse",
        headers: Object.fromEntries(server.headers.map((item) => [item.name, item.value])), tools: selection };
    }
  }
  return merged;
}

function promptBlocks(blocks: readonly ContentBlock[]): UserBlock[] {
  if (!blocks.length) throw RequestError.invalidParams(undefined, "prompt must contain a content block");
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "resource_link") {
      return { type: "resource_link", uri: block.uri, name: block.name,
        ...(block.title !== undefined ? { title: block.title } : {}),
        ...(block.description !== undefined ? { description: block.description } : {}),
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        ...(block.size !== undefined ? { size: block.size } : {}),
        ...(block.annotations !== undefined ? { annotations: block.annotations } : {}) };
    }
    throw RequestError.invalidParams(undefined, `unsupported prompt block: ${block.type}`);
  });
}

function toolUpdate(event: RunEvent): SessionUpdate | undefined {
  if (event.type === "text_delta") return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
  if (event.type === "tool_call") return { sessionUpdate: "tool_call", toolCallId: event.id, title: event.name,
    name: event.name, kind: event.name === "read_file" ? "read" : event.name === "write_file" ? "edit" : "execute",
    status: "pending", rawInput: event.arguments };
  if (event.type === "tool_start") return { sessionUpdate: "tool_call_update", toolCallId: event.id, status: "in_progress" };
  if (event.type === "tool_result") return { sessionUpdate: "tool_call_update", toolCallId: event.id,
    status: event.result.isError ? "failed" : "completed", rawOutput: event.result };
  return undefined;
}

function reverseResult(raw: unknown, maxOutputBytes: number): ToolResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return errorResult("unsupported_content", "invalid reverse tool result");
  const result = raw as Record<string, unknown>;
  if (!Array.isArray(result.content)) return errorResult("unsupported_content", "invalid reverse tool content");
  const content: ToolContent[] = [];
  let bytes = 0;
  for (const item of result.content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return errorResult("unsupported_content", "invalid reverse tool block");
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      bytes += Buffer.byteLength(block.text);
      content.push({ type: "text", text: block.text });
    } else if (block.type === "json") {
      let serialized: string | undefined;
      try { serialized = JSON.stringify(block.value); } catch { /* unsupported value */ }
      if (serialized === undefined) return errorResult("unsupported_content", "invalid JSON reverse tool block");
      bytes += Buffer.byteLength(serialized);
      content.push({ type: "json", value: block.value });
    } else if (block.type === "image" && (block.mimeType === "image/png" || block.mimeType === "image/jpeg") && typeof block.data === "string") {
      const image = block.data;
      if (image.length > Math.ceil(16 * 1024 * 1024 * 4 / 3) + 4) return errorResult("result_too_large", "reverse tool result exceeds 16 MiB");
      if (image.length % 4 !== 0) return errorResult("unsupported_content", "invalid reverse tool image");
      const padding = image.endsWith("==") ? 2 : image.endsWith("=") ? 1 : 0;
      for (let index = 0; index < image.length - padding; index++) {
        const code = image.charCodeAt(index);
        if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
          return errorResult("unsupported_content", "invalid reverse tool image");
        }
      }
      for (let index = image.length - padding; index < image.length; index++) if (image[index] !== "=") return errorResult("unsupported_content", "invalid reverse tool image");
      const decoded = Buffer.from(image, "base64");
      if (decoded.toString("base64") !== image) return errorResult("unsupported_content", "invalid reverse tool image");
      bytes += decoded.length;
      content.push({ type: "image", mimeType: block.mimeType, data: image });
    } else return errorResult("unsupported_content", "unsupported reverse tool block");
    if (bytes > 16 * 1024 * 1024) return errorResult("result_too_large", "reverse tool result exceeds 16 MiB");
  }
  return capResult({ isError: result.isError === true, content }, maxOutputBytes);
}

function compiledSchema(raw: unknown, name: string): { schema: { type: "object"; [key: string]: unknown }; validate: (args: unknown) => string | undefined } {
  const schema = object(raw, `tool ${name}.inputSchema`);
  if (schema.type !== "object") throw RequestError.invalidParams(undefined, "tool inputSchema must be an object schema");
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  let check: ReturnType<typeof ajv.compile>;
  try { check = ajv.compile(schema); }
  catch { throw RequestError.invalidParams(undefined, "unsupported tool inputSchema"); }
  if ((check as typeof check & { $async?: boolean }).$async) throw RequestError.invalidParams(undefined, "async tool schemas are unsupported");
  return { schema: structuredClone(schema) as { type: "object"; [key: string]: unknown },
    validate: (args) => check(args) ? undefined : ajv.errorsText(check.errors) };
}

function reverseAlias(name: string, toolId: string): string {
  const prefix = `raw_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 51);
  return `${prefix}_${createHash("sha256").update(toolId).digest("hex").slice(0, 12)}`;
}

export function createAcpServer(options: AcpServerOptions): AcpServer {
  const app = agent({ name: "raw-cli" });
  const sessions = new Map<string, SessionRecord>();
  const providerFactory = options.providerFactory ?? createProvider;
  const configuredMcp = options.mcpServers ?? options.runtime.mcpServers;
  let connection: AgentConnection | undefined;
  let peer: AgentContext | undefined;
  let initialized = false;
  let peerRaw: RawCapabilities = {};
  let closing: Promise<void> | undefined;
  const startupController = new AbortController();
  const pendingCreations = new Set<Promise<unknown>>();
  const close = (): Promise<void> => {
    if (closing) return closing;
    startupController.abort();
    closing = (async () => {
      for (const session of sessions.values()) session.agent.abort();
      const activeCleanup = Promise.allSettled([...sessions.values()].map(async (session) => {
        await session.agent.close();
        await session.mcp.close();
      }));
      await Promise.all([activeCleanup, Promise.allSettled([...pendingCreations])]);
      sessions.clear();
      connection?.close();
    })();
    return closing;
  };
  const getSession = (id: string): SessionRecord => {
    const session = sessions.get(id);
    if (!session) throw rawError(rawErrors.unknownSession, "unknown session");
    return session;
  };
  const requireCapability = (flag: RawCapability) => {
    if (!peerRaw[flag]) throw rawError(rawErrors.capability, `raw ${flag} capability was not negotiated`);
  };
  app.onConnect((connected) => {
    if (connection) { connected.close(); return; }
    connection = connected;
    peer = connected.client;
    connected.signal.addEventListener("abort", () => { void close(); }, { once: true });
  });
  app.onRequest("initialize", ({ params }) => {
    peerRaw = rawCapabilities(params._meta);
    initialized = true;
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "raw-cli", version: "0.1.0" },
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      _meta: { raw: { runtimeInfo: true, sessionConfigure: true, toolRegister: true,
        toolCall: true, sessionCompact: true, toolCancel: true } } };
  });
  app.onRequest("session/new", async ({ params }) => {
    if (!initialized) throw RequestError.invalidRequest(undefined, "initialize first");
    if (!isAbsolute(params.cwd)) throw RequestError.invalidParams(undefined, "cwd must be absolute");
    try { if (!statSync(params.cwd).isDirectory()) throw new Error("not a directory"); }
    catch { throw RequestError.invalidParams(undefined, "cwd must be an existing directory"); }
    if (!options.runtime.profile) throw rawError(rawErrors.upstream, "provider and model are required");
    const profile = options.runtime.profile;
    if (startupController.signal.aborted) throw rawError(rawErrors.cancelled, "connection closed");
    const creation = (async () => {
      const id = randomUUID();
      const registry = createToolRegistry(options.runtime.toolRules, options.runtime.profile?.vision === true);
      const mcp = await connectMcpServers({ servers: sessionMcpServers(params.mcpServers, configuredMcp), registry,
        cwd: params.cwd, timeoutMs: options.runtime.requestTimeoutMs, signal: startupController.signal });
      try {
      if (startupController.signal.aborted) throw rawError(rawErrors.cancelled, "connection closed");
      const agentSession = createAgent({ provider: providerFactory(profile), registry,
        cwd: params.cwd, system: options.runtime.systemPrompt,
        maxSteps: options.runtime.maxSteps, maxOutputBytes: options.runtime.maxOutputBytes,
        requestTimeoutMs: options.runtime.requestTimeoutMs, autoApprove: options.runtime.autoApprove,
        approve: async (name, args, signal, toolCallId) => {
          if (!peer) throw rawError(rawErrors.upstream, "ACP client disconnected");
          const response = await withAbort(peer.request("session/request_permission", {
            sessionId: id, toolCall: { toolCallId: toolCallId ?? randomUUID(), title: name, name, status: "pending", rawInput: args },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" }],
          }, { ...(signal ? { cancellationSignal: signal } : {}) }), signal);
          return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
        },
      });
      if (startupController.signal.aborted) { await agentSession.close(); throw rawError(rawErrors.cancelled, "connection closed"); }
      sessions.set(id, { id, agent: agentSession, registry, mcp, registered: new Map() });
      return { sessionId: id };
      } catch (error) { await mcp.close(); throw error; }
    })();
    pendingCreations.add(creation);
    try { return await creation; }
    finally { pendingCreations.delete(creation); }
  });
  app.onRequest("session/prompt", async ({ params, client }) => {
    const session = getSession(params.sessionId);
    if (session.agent.state !== "idle") throw rawError(rawErrors.busy, "session is busy");
    const input = promptBlocks(params.prompt);
    let updateError: unknown;
    let updateChain = Promise.resolve();
    const result = await session.agent.run(input, (event) => {
      const update = toolUpdate(event);
      if (!update) return;
      updateChain = updateChain.then(() => client.notify("session/update", { sessionId: session.id, update }))
        .catch((error: unknown) => { updateError = error; session.agent.abort(); });
    });
    await updateChain;
    if (updateError) throw rawError(rawErrors.upstream, "session update delivery failed");
    if (result.status === "error") throw rawError(rawErrors.upstream, "agent provider failed");
    return { stopReason: result.status === "completed" ? "end_turn" as const
      : result.status === "max_steps" ? "max_turn_requests" as const : "cancelled" as const,
      ...(result.status === "max_steps" ? { _meta: { raw: { code: "max_steps" } } } : {}) };
  });
  app.onNotification("session/cancel", ({ params }) => { sessions.get(params.sessionId)?.agent.abort(); });

  app.onRequest("_raw/runtime/info", (params: unknown) => object(params, "runtime info"), ({ params }) => {
    requireCapability("runtimeInfo");
    fields(params, ["sessionId"], "runtime info");
    const session = params.sessionId === undefined ? undefined : getSession(string(params.sessionId, "sessionId"));
    return { profile: options.runtime.profile ? { name: options.runtime.profile.name,
      provider: options.runtime.profile.provider, model: options.runtime.profile.model } : undefined,
      limits: { maxSteps: options.runtime.maxSteps, maxOutputBytes: options.runtime.maxOutputBytes,
        requestTimeoutMs: options.runtime.requestTimeoutMs },
      tools: session?.agent.toolDefinitions.map((tool) => ({ alias: tool.name,
        origin: session.mcp.exposed.find((item) => item.alias === tool.name)?.server ?? (tool.name.startsWith("raw_") ? "peer" : "built-in") })) ?? [],
      mcpCatalog: session?.mcp.catalog.map((item) => ({ ...item, exposed: session.agent.toolDefinitions.some((visible) => visible.name === item.alias) })) ?? [] };
  });
  app.onRequest("_raw/session/configure", (params: unknown) => object(params, "session configure"), ({ params }) => {
    requireCapability("sessionConfigure");
    fields(params, ["sessionId", "tools"], "session configure");
    const session = getSession(string(params.sessionId, "sessionId"));
    if (session.agent.state !== "idle") throw rawError(rawErrors.busy, "session is busy");
    const tools = stringArray(params.tools, "tools");
    try { session.mcp.activate(tools); return { schemaRevision: session.agent.setToolView(tools), tools: session.agent.toolDefinitions.map((item) => item.name) }; }
    catch { throw rawError(rawErrors.tool, "unknown tool selection"); }
  });
  app.onRequest("_raw/tool/register", (params: unknown) => object(params, "tool registration"), ({ params }) => {
    requireCapability("toolRegister"); requireCapability("toolCall");
    fields(params, ["sessionId", "name", "description", "inputSchema"], "tool registration");
    const session = getSession(string(params.sessionId, "sessionId"));
    if (session.agent.state !== "idle") throw rawError(rawErrors.busy, "session is busy");
    const name = string(params.name, "tool name");
    const description = string(params.description, "tool description");
    if (session.registered.has(name)) throw rawError(rawErrors.duplicate, "duplicate tool registration");
    const { schema, validate } = compiledSchema(params.inputSchema, name);
    const toolId = randomUUID();
    const alias = reverseAlias(name, toolId);
    if (session.registry.definitions().some((item) => item.name === alias)) throw rawError(rawErrors.duplicate, "duplicate tool alias");
    const visible = session.agent.toolDefinitions.map((item) => item.name);
    session.registry.register({ name: alias, canonicalName: `acp:${name}`, description, inputSchema: schema, validateArgs: validate,
      handler: async (args, context) => {
        if (!peer) return errorResult("peer_disconnected", "ACP client disconnected");
        const invocationId = randomUUID();
        const requestController = new AbortController();
        const onAbort = () => {
          requestController.abort();
          if (peerRaw.toolCancel) void peer!.notify("_raw/tool/cancel", { sessionId: session.id, invocationId }).catch(() => {});
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { onAbort(); reject(rawError(rawErrors.timeout, "reverse request timed out")); }, options.runtime.requestTimeoutMs);
        });
        try {
          const result = await withAbort(Promise.race([peer.request("_raw/tool/call", { sessionId: session.id, toolId, invocationId,
            arguments: args }, { cancellationSignal: requestController.signal }), expired]), context.signal);
          if (context.signal?.aborted) return errorResult("cancelled", "reverse tool call cancelled");
          return reverseResult(result, context.maxOutputBytes);
        } catch (error) {
          if (context.signal?.aborted) return errorResult("cancelled", "reverse tool call cancelled");
          if (requestController.signal.aborted || (error instanceof RequestError && error.code === rawErrors.timeout)) return errorResult("callback_timeout", "reverse tool call timed out");
          return errorResult("callback_error", "reverse tool call failed");
        } finally { if (timer) clearTimeout(timer); context.signal?.removeEventListener("abort", onAbort); }
      } });
    session.registered.set(name, toolId);
    const permitted = session.registry.definitions().some((tool) => tool.name === alias);
    const schemaRevision = permitted ? session.agent.setToolView([...visible, alias]) : session.agent.toolSchemaRevision;
    return { toolId, alias, schemaRevision };
  });
  app.onRequest("_raw/session/compact", (params: unknown) => object(params, "session compact"), async ({ params }) => {
    requireCapability("sessionCompact");
    fields(params, ["sessionId"], "session compact");
    const session = getSession(string(params.sessionId, "sessionId"));
    if (session.agent.state !== "idle") throw rawError(rawErrors.busy, "session is busy");
    const profile = options.runtime.resolveCompactProfile();
    try {
      return await session.agent.compact({ provider: providerFactory(profile),
        keepRecentTurns: options.runtime.compact.keepRecentTurns,
        maxOutputTokens: options.runtime.compact.maxOutputTokens });
    } catch { throw rawError(rawErrors.upstream, "compaction failed"); }
  });
  return { app, close };
}
