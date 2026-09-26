import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DashboardError } from "./errors.js";

export function createDashboardToken(): string { return randomBytes(32).toString("base64url"); }
export function verifyDashboardRequest(request: IncomingMessage, origin: string, token: string, api: boolean): void {
  if (request.headers.host !== new URL(origin).host) throw new DashboardError(403, "foreign_host", "Dashboard Host must match its loopback listener");
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new DashboardError(403, "foreign_origin", "Dashboard Origin must match its loopback listener");
  if (!api) return;
  const value = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(value);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DashboardError(401, "unauthorized", "Open the current authenticated dashboard launch link");
}
export function responseHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}
