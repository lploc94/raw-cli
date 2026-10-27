import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DashboardError } from "./errors.js";

export function createDashboardToken(): string { return randomBytes(32).toString("base64url"); }
export function verifyDashboardRequest(request: IncomingMessage, origins: ReadonlySet<string>, token: string, api: boolean): void {
  const host = request.headers.host;
  if (host === undefined || ![...origins].some((origin) => new URL(origin).host === host)) throw new DashboardError(403, "foreign_host", "Dashboard Host must match its registered listener");
  if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) throw new DashboardError(403, "foreign_origin", "Dashboard Origin must match its registered listener");
  if (!api) return;
  const value = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(value);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DashboardError(401, "unauthorized", "Open the current authenticated dashboard launch link");
}
export function responseHeaders(response: ServerResponse, styleNonce: string): void {
  response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}
const QUICK_TUNNEL_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/;
/** The only public origin a dashboard may add: a bare `https://<name>.trycloudflare.com`, so no other host can be registered by mistake. */
export function quickTunnelOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DashboardError(400, "invalid_origin", "Public origin must be an https quick tunnel URL"); }
  if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST.test(url.hostname) || url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || /^https:\/\/[^/]*[?#]/.test(value))
    throw new DashboardError(400, "invalid_origin", "Public origin must be a bare https://<name>.trycloudflare.com quick tunnel origin");
  return url.origin;
}
