import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fixtureMcpServer } from "./mcp-server.js";

export async function startMcpHttp(transport: "sse" | "streamable-http", label: string,
  mode?: "large-discovery" | "large-result" | "echo-error" | "echo-initialize") {
  const owners: Array<{ server: Server; transport: SSEServerTransport | StreamableHTTPServerTransport }> = [];
  const sessions = new Map<string, SSEServerTransport>();
  let getRequests = 0;
  const streamable = transport === "streamable-http" ? new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID }) : undefined;
  if (streamable) {
    const mcp = fixtureMcpServer(label, 2, false, mode === "large-discovery" || mode === "large-result" ? mode : undefined);
    await mcp.connect(streamable as unknown as Transport);
    owners.push({ server: mcp, transport: streamable });
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET") getRequests++;
      if (streamable) {
        if (mode === "echo-initialize") { res.writeHead(500); res.end("rejected Authorization: Bearer test-secret-header; url token=test-secret-query"); return; }
        if (mode === "echo-error" && req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw) as { method?: string };
          if (body.method === "tools/call") { res.writeHead(500); res.end("rejected Authorization: Bearer test-secret-header; url token=test-secret-query"); return; }
          await streamable.handleRequest(req, res, body); return;
        }
        await streamable.handleRequest(req, res); return;
      }
      if (req.method === "GET" && req.url === "/sse") {
        const channel = new SSEServerTransport("/messages", res);
        const mcp = fixtureMcpServer(label, 2, false, mode === "large-discovery" || mode === "large-result" ? mode : undefined);
        sessions.set(channel.sessionId, channel);
        channel.onclose = () => sessions.delete(channel.sessionId);
        owners.push({ server: mcp, transport: channel });
        await mcp.connect(channel as unknown as Transport);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const session = new URL(req.url, "http://127.0.0.1").searchParams.get("sessionId");
        const channel = session ? sessions.get(session) : undefined;
        if (!channel) { res.writeHead(404); res.end(); return; }
        await channel.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) { res.writeHead(500); res.end(String(error)); } }
  };
  const http = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/${transport === "sse" ? "sse" : "mcp"}`,
    get getRequests() { return getRequests; },
    dropStreams: async () => {
      if (streamable) streamable.closeStandaloneSSEStream();
      else await Promise.all([...sessions.values()].map((channel) => channel.close()));
    },
    close: async () => {
      for (const owner of owners) { await owner.server.close(); await owner.transport.close(); }
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}
