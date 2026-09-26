import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { contained } from "../management/files.js";
import { isDashboardPage } from "./contract.js";
import { DashboardError } from "./errors.js";

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };
export async function serveDashboardStatic(request: IncomingMessage, response: ServerResponse, assetsRoot: string, pathname: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") throw new DashboardError(404, "not_found", "Route not found");
  let relative: string;
  if (isDashboardPage(pathname)) relative = "index.html";
  else if (/^\/assets\/.+/.test(pathname) || pathname === "/favicon.svg") relative = decodeURIComponent(pathname.slice(1));
  else throw new DashboardError(404, "not_found", "Route not found");
  const root = resolve(assetsRoot); const path = join(root, relative);
  if (!contained(root, path)) throw new DashboardError(404, "not_found", "Asset not found");
  try {
    const actualRoot = await realpath(root); const actual = await realpath(path);
    if (!contained(actualRoot, actual) || !(await stat(actual)).isFile()) throw new DashboardError(404, "not_found", "Asset not found");
    const contentType = mime[extname(actual)];
    if (!contentType) throw new DashboardError(404, "not_found", "Asset type not served");
    const bytes = await readFile(actual);
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": bytes.length, "Cache-Control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DashboardError(relative === "index.html" ? 503 : 404,
      relative === "index.html" ? "assets_unavailable" : "not_found", relative === "index.html" ? "Dashboard assets are unavailable; rebuild or reinstall Raw" : "Asset not found");
    throw error;
  }
}
