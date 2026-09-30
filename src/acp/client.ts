import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type ContentBlock,
  type McpServer, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse,
  type ListSessionsResponse } from "@agentclientprotocol/sdk";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import WebSocket from "ws";

export interface ParentToolCall {
  sessionId: string;
  toolId: string;
  invocationId: string;
  arguments: Record<string, unknown>;
}

export type ParentToolHandler = (call: ParentToolCall, signal: AbortSignal) => Promise<unknown> | unknown;

export type AcpClientOptions = ({ command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv } | { url: string }) & {
  onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  onUpdate?: (notification: SessionNotification) => void;
};

export interface AcpParentClient {
  readonly connection: ClientConnection;
  readonly pid?: number;
  initializeResult: unknown;
  newSession(cwd: string, mcpServers?: McpServer[]): Promise<string>;
  listSessions(cwd?: string, cursor?: string): Promise<ListSessionsResponse>;
  loadSession(sessionId: string, cwd: string, mcpServers?: McpServer[]): Promise<void>;
  resumeSession(sessionId: string, cwd: string, mcpServers?: McpServer[]): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  registerTool(sessionId: string, name: string, description: string, inputSchema: Record<string, unknown>, handler: ParentToolHandler, panels?: readonly unknown[]): Promise<{ toolId: string; alias: string; contextRevision: number }>;
  close(): Promise<void>;
}

export async function createAcpClient(options: AcpClientOptions): Promise<AcpParentClient> {
  const handlers = new Map<string, ParentToolHandler>();
  const activeCalls = new Map<string, AbortController>();
  const app = client({ name: "raw-cli-parent" });
  app.onRequest("session/request_permission", ({ params }) => options.onPermission?.(params)
    ?? { outcome: { outcome: "selected", optionId: "deny" } });
  app.onNotification("session/update", ({ params }) => { options.onUpdate?.(params); });
  app.onRequest("_raw/tool/call", (params: unknown) => params as ParentToolCall, async ({ params }) => {
    const handler = handlers.get(params.toolId);
    if (!handler) return { isError: true, content: [{ type: "text", text: "unknown reverse tool" }] };
    const controller = new AbortController();
    activeCalls.set(params.invocationId, controller);
    try { return await handler(params, controller.signal); }
    catch { return { isError: true, content: [{ type: "text", text: "reverse tool failed" }] }; }
    finally { activeCalls.delete(params.invocationId); }
  });
  app.onNotification("_raw/tool/cancel", (params: unknown) => params as { invocationId: string }, ({ params }) => {
    activeCalls.get(params.invocationId)?.abort();
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let spawnFailure: Promise<never> | undefined;
  let stream;
  if ("command" in options) {
    child = spawn(options.command, [...options.args], { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"] });
    spawnFailure = new Promise<never>((_resolve, reject) => child!.once("error", reject));
    child.stderr.on("data", () => {});
    stream = ndJsonStream(Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>);
  } else stream = createWebSocketStream(options.url, { WebSocket: WebSocket as unknown as WebSocketConstructor });
  const connection = app.connect(stream);
  connection.signal.addEventListener("abort", () => {
    for (const controller of activeCalls.values()) controller.abort();
  }, { once: true });
  let initializeResult: unknown;
  try {
    const initialize = connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}, _meta: { raw: { runtimeInfo: true, sessionConfigure: true, toolRegister: true,
        toolCall: true, toolCancel: true, sessionCompact: true, panelsV2: true } } });
    initializeResult = await (spawnFailure ? Promise.race([initialize, spawnFailure]) : initialize);
  } catch (error) {
    connection.close();
    child?.kill("SIGTERM");
    throw error;
  }
  const close = async () => {
    for (const controller of activeCalls.values()) controller.abort();
    connection.close();
    if (!child) return;
    child.stdin.end();
    const exited = () => child!.exitCode !== null || child!.signalCode !== null;
    const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      if (exited()) { resolve(true); return; }
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child!.off("exit", onExit); resolve(exited()); }, timeoutMs);
      child!.once("exit", onExit);
    });
    if (await waitForExit(5000)) return;
    child.kill("SIGTERM");
    if (await waitForExit(1000)) return;
    child.kill("SIGKILL");
    if (!(await waitForExit(1000))) throw new Error("raw ACP child did not exit after SIGKILL");
  };
  return {
    connection,
    ...(child?.pid !== undefined ? { pid: child.pid } : {}),
    initializeResult,
    newSession: async (cwd, mcpServers = []) => (await connection.agent.request("session/new", { cwd, mcpServers })).sessionId,
    listSessions: (cwd, cursor) => connection.agent.request("session/list", {
      ...(cwd === undefined ? {} : { cwd }), ...(cursor === undefined ? {} : { cursor }) }),
    loadSession: async (sessionId, cwd, mcpServers = []) => {
      await connection.agent.request("session/load", { sessionId, cwd, mcpServers });
    },
    resumeSession: async (sessionId, cwd, mcpServers = []) => {
      await connection.agent.request("session/resume", { sessionId, cwd, mcpServers });
    },
    deleteSession: async (sessionId) => { await connection.agent.request("session/delete", { sessionId }); },
    prompt: (sessionId, prompt) => connection.agent.request("session/prompt", { sessionId,
      prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt }),
    cancel: (sessionId) => connection.agent.notify("session/cancel", { sessionId }),
    registerTool: async (sessionId, name, description, inputSchema, handler, panels) => {
      const response = await connection.agent.request<{ toolId: string; alias: string; contextRevision: number }>("_raw/tool/register",
        { sessionId, name, description, inputSchema, ...(panels ? { panels } : {}) });
      handlers.set(response.toolId, handler);
      return response;
    },
    close,
  };
}
