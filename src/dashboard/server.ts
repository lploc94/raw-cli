import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { configFilePath } from "../config.js";
import { record } from "../management/agents.js";
import { readManagedConfig } from "../management/config.js";
import { packageRoot } from "../package-root.js";
import { openSessionStore, type SessionStore, type SessionStoreOptions } from "../sessions/store.js";
import { SessionOperations, type AttachSessionRuntime } from "../sessions/operations.js";
import { createDashboardToken, responseHeaders, verifyDashboardRequest } from "./auth.js";
import { DASHBOARD_API_VERSION, type DashboardBootstrap } from "./contract.js";
import { DashboardError, json, readJson, sendError } from "./errors.js";
import { serveDashboardStatic } from "./static.js";

export type DashboardRoute = (request: IncomingMessage, response: ServerResponse, context: DashboardContext) => Promise<boolean>;
export interface DashboardContext {
  instanceId: string; cwd: string; configPath: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
  preferredAgent?: string; store?: SessionStore; operations?: SessionOperations; storeDiagnostic?: string;
  json: typeof json; readJson: typeof readJson;
  onClose(cleanup: () => void | Promise<void>): void;
}
export interface DashboardOptions {
  port?: number; cwd?: string; configPath?: string; agent?: string; env?: NodeJS.ProcessEnv;
  assetsRoot?: string; signal?: AbortSignal;
  storeFactory?: (options: SessionStoreOptions) => SessionStore;
  attach?: AttachSessionRuntime;
  routes?: (context: DashboardContext) => DashboardRoute[];
}
export interface DashboardServer {
  url: string; launchUrl: string; token: string; port: number; context: DashboardContext;
  close(): Promise<void>;
}
export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardServer> {
  if (options.signal?.aborted) throw new DashboardError(503, "cancelled", "Dashboard startup cancelled");
  const port = options.port ?? 8787;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new DashboardError(400, "invalid_port", "port must be an integer from 0 to 65535");
  const cwd = realpathSync(options.cwd ?? process.cwd());
  if (!statSync(cwd).isDirectory()) throw new DashboardError(400, "invalid_workspace", "workspace must be a directory");
  const env = options.env ?? process.env;
  const configPath = configFilePath({ cwd, env, ...(options.configPath ? { configPath: options.configPath } : {}) });
  const token = createDashboardToken(); const controller = new AbortController();
  const cleanup: Array<() => void | Promise<void>> = [];
  const context: DashboardContext = { instanceId: randomUUID(), cwd, configPath, env, signal: controller.signal,
    ...(options.agent ? { preferredAgent: options.agent } : {}), json, readJson, onClose: (fn) => { cleanup.push(fn); } };
  try {
    context.store = (options.storeFactory ?? openSessionStore)({ cwd, env });
    context.operations = new SessionOperations({ store: context.store, env, ...(options.attach ? { attach: options.attach } : {}) });
  } catch (error) { context.store?.close(); delete context.store; context.storeDiagnostic = error instanceof Error ? error.message : String(error); }
  const assetsRoot = options.assetsRoot ?? join(packageRoot(), "dist", "dashboard");
  let routes: DashboardRoute[];
  try { routes = options.routes?.(context) ?? []; }
  catch (error) {
    controller.abort(); await context.operations?.close();
    await Promise.allSettled(cleanup.map((fn) => Promise.resolve().then(fn)));
    context.store?.close(); throw error;
  }
  const version = String((JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown");
  let origin = ""; let closing: Promise<void> | undefined; let listeningReady = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    responseHeaders(response);
    if (controller.signal.aborted) throw new DashboardError(503, "closing", "Dashboard is stopping");
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new DashboardError(400, "invalid_path", "Invalid request target");
    const rawPath = request.url.split("?")[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); }
    catch { throw new DashboardError(400, "invalid_path", "Invalid URL encoding"); }
    if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === ".." || part === ".")) throw new DashboardError(404, "not_found", "Route not found");
    const url = new URL(request.url, origin); const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
    verifyDashboardRequest(request, origin, token, api);
    if (api) {
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        let config: DashboardBootstrap["config"];
        try {
          const current = await readManagedConfig({ configPath, cwd, env }); const data = current.data;
          config = { exists: current.exists, revision: current.revision, canonical: current.canonical, valid: !!data,
            ...(current.diagnostic ? { diagnostic: current.diagnostic } : {}), agents: Object.keys(record(data?.agents)), models: Object.keys(record(data?.models)),
            ...(typeof data?.default_agent === "string" ? { defaultAgent: data.default_agent } : {}) };
        } catch (error) { config = { exists: true, valid: false, diagnostic: error instanceof Error ? error.message : String(error), agents: [], models: [] }; }
        const bootstrap: DashboardBootstrap = { apiVersion: DASHBOARD_API_VERSION, version, instanceId: context.instanceId,
          cwd, configPath, ...(context.preferredAgent ? { preferredAgent: context.preferredAgent } : {}), config,
          store: { available: !!context.store, ...(context.storeDiagnostic ? { diagnostic: context.storeDiagnostic } : {}) } };
        json(response, 200, bootstrap); return;
      }
      for (const route of routes) if (await route(request, response, context)) return;
      throw new DashboardError(404, "not_found", "API route not found");
    }
    await serveDashboardStatic(request, response, assetsRoot, url.pathname);
  };
  const http = createServer((request, response) => {
    response.on("error", () => {});
    void handle(request, response).catch((error) => sendError(response, error));
  });
  http.headersTimeout = 15_000; http.requestTimeout = 30_000;
  const close = (): Promise<void> => closing ??= (async () => {
    controller.abort();
    const listenerClosed = new Promise<void>((resolve) => {
      if (!http.listening) { resolve(); return; }
      http.close(() => resolve()); http.closeIdleConnections();
    });
    await context.operations?.close();
    await Promise.allSettled(cleanup.map((fn) => Promise.resolve().then(fn)));
    http.closeAllConnections(); await listenerClosed;
    context.store?.close();
    options.signal?.removeEventListener("abort", onAbort);
  })();
  const onAbort = () => {
    controller.abort();
    // During listen(), defer cleanup until its callback settles so a late bind cannot escape close().
    if (listeningReady) void close().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new DashboardError(503, "cancelled", "Dashboard startup cancelled");
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => { http.off("listening", ready); reject(error.code === "EADDRINUSE"
        ? new DashboardError(409, "port_in_use", `Port ${port} is already in use; choose --port 0 or another port`) : error); };
      const ready = () => { listeningReady = true; http.off("error", failed); resolve(); };
      http.once("error", failed); http.once("listening", ready); http.listen(port, "127.0.0.1");
    });
    if (controller.signal.aborted) throw new DashboardError(503, "cancelled", "Dashboard startup cancelled");
    const address = http.address(); if (!address || typeof address === "string") throw new Error("Dashboard listener address unavailable");
    origin = new URL(`http://127.0.0.1:${address.port}`).origin;
    return { url: origin, launchUrl: `${origin}/#token=${token}`, token, port: address.port, context, close };
  } catch (error) { await close(); throw error; }
}
