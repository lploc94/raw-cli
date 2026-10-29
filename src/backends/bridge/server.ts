import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "../../tools/registry.js";
import type { ToolResult } from "../../tools/types.js";
import { VERSION } from "../../version.js";

/** The MCP server name the CLIs see; they prefix its tools with it (Claude: `mcp__raw__todo`). */
export const BRIDGE_SERVER_NAME = "raw";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BridgeHandlers {
  /** The tools offered now: the agent's bridged selection, without `deny`. */
  tools(): readonly ToolDefinition[];
  /** Runs one call in Raw; rejects with a message when no turn can take it. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

export interface RawBridge {
  readonly url: string;
  /** The bearer token of this runtime; only for the proxy's environment (Invariant 3). */
  readonly token: string;
  close(): Promise<void>;
}

function mcpResult(result: ToolResult): CallToolResult {
  const content = result.content.map((block) => block.type === "image"
    ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
    : { type: "text" as const, text: block.type === "text" ? block.text : JSON.stringify(block.value) });
  return { content, ...(result.isError ? { isError: true } : {}) };
}

function sameToken(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

/**
 * Raw's own MCP server for one backend runtime: loopback HTTP only, one random bearer token, no browser origins
 * (Invariant 4). The CLI reaches it through `raw __bridge-proxy`, which it starts as a stdio MCP server.
 */
export async function startBridge(handlers: BridgeHandlers): Promise<RawBridge> {
  const token = randomBytes(32).toString("hex");
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const deny = (response: ServerResponse, status: number) => { response.writeHead(status).end(); };
  const mcp = () => {
    const server = new Server({ name: BRIDGE_SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: handlers.tools().map((tool) => ({ name: tool.name,
      description: tool.description, inputSchema: structuredClone(tool.inputSchema) as { type: "object" } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try { return mcpResult(await handlers.call(request.params.name, request.params.arguments ?? {}, extra.signal)); }
      catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    });
    return server;
  };
  const read = (request: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("request too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
  const http: HttpServer = createServer((request, response) => {
    void (async () => {
      if (!LOOPBACK.has(request.socket.remoteAddress ?? "") || request.headers.origin !== undefined) return deny(response, 403);
      if (!sameToken(request.headers.authorization, token)) return deny(response, 401);
      if (request.url !== "/mcp") return deny(response, 404);
      const sessionId = request.headers["mcp-session-id"];
      const body = request.method === "POST" ? await read(request) : undefined;
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId !== undefined || request.method !== "POST" || !isInitializeRequest(body)) return deny(response, sessionId === undefined ? 400 : 404);
        const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, created); } });
        created.onclose = () => { if (created.sessionId) transports.delete(created.sessionId); };
        await mcp().connect(created as Transport);
        transport = created;
      }
      await transport.handleRequest(request, response, body);
    })().catch(() => { if (!response.headersSent) deny(response, 400); else response.end(); });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", () => resolve()); });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    async close() {
      await Promise.all([...transports.values()].map((transport) => transport.close().catch(() => {})));
      transports.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
