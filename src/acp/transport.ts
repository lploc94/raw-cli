import { createServer, type Server as HttpServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type AnyMessage, type AgentConnection, type Stream } from "@agentclientprotocol/sdk";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { AcpServer } from "./methods.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export async function serveAcpStdio(server: AcpServer): Promise<void> {
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>);
  const connection = server.app.connect(stream);
  try { await connection.closed; }
  finally { await server.close(); }
}

function socketStream(socket: WebSocket): Stream {
  let onMessage: ((data: RawData, binary: boolean) => void) | undefined;
  let onClose: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  let readableOpen = true;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      onMessage = (data, binary) => {
        if (binary) { socket.close(1003, "text frames required"); return; }
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (raw.byteLength > MAX_FRAME_BYTES) { socket.close(1009, "frame too large"); return; }
        let message: unknown;
        try {
          message = JSON.parse(raw.toString()) as unknown;
        } catch {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
          return;
        }
        controller.enqueue(message as AnyMessage);
      };
      onClose = () => { if (readableOpen) { readableOpen = false; controller.close(); } };
      onError = (error) => { if (readableOpen) { readableOpen = false; controller.error(error); } };
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    },
    cancel() { readableOpen = false; if (socket.readyState === WebSocket.OPEN) socket.close(); },
  });
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket closed");
      return new Promise<void>((resolve, reject) => socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve()));
    },
    close() { if (socket.readyState === WebSocket.OPEN) socket.close(); },
    abort() { socket.terminate(); },
  });
  socket.once("close", () => {
    if (onMessage) socket.off("message", onMessage);
    if (onClose) socket.off("close", onClose);
    if (onError) socket.off("error", onError);
  });
  return { readable, writable };
}

export interface AcpWsListener {
  readonly port: number;
  close(): Promise<void>;
}

export async function serveAcpWebSocket(options: {
  host: string;
  port: number;
  serverFactory: () => AcpServer;
}): Promise<AcpWsListener> {
  if (!["127.0.0.1", "::1", "localhost"].includes(options.host)) throw new Error("ACP WebSocket must bind loopback");
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("invalid ACP WebSocket port");
  const http: HttpServer = createServer((_req, response) => { response.writeHead(404); response.end(); });
  const sockets = new Set<WebSocket>();
  const connections = new Set<AgentConnection>();
  const servers = new Set<AcpServer>();
  const ws = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  http.on("upgrade", (request, socket, head) => {
    if (request.headers.origin || request.url !== "/" || socket.destroyed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    ws.handleUpgrade(request, socket, head, (clientSocket) => ws.emit("connection", clientSocket, request));
  });
  ws.on("connection", (socket) => {
    sockets.add(socket);
    const server = options.serverFactory();
    servers.add(server);
    const connection = server.app.connect(socketStream(socket));
    connections.add(connection);
    socket.once("close", () => connection.close());
    void connection.closed.finally(async () => {
      connections.delete(connection);
      sockets.delete(socket);
      servers.delete(server);
      await server.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("ACP WebSocket address unavailable");
  return { port: address.port, close: async () => {
    for (const connection of connections) connection.close();
    for (const socket of sockets) socket.terminate();
    await Promise.allSettled([...servers].map((server) => server.close()));
    await new Promise<void>((resolve, reject) => ws.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  } };
}
