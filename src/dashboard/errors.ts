import type { IncomingMessage, ServerResponse } from "node:http";
import { ManagementError } from "../management/files.js";
import { SessionOperationError } from "../sessions/operations.js";
import { MAX_JSON_BYTES } from "./contract.js";

export class DashboardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = "DashboardError"; }
}
export function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(encoded);
}
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  let status = 500; let code = "internal_error"; let message = "Dashboard operation failed"; let details: unknown;
  if (error instanceof DashboardError) { ({ status, code, message, details } = error); }
  else if (error instanceof ManagementError || error instanceof SessionOperationError) {
    code = error.code; message = error.message;
    status = code === "not_found" ? 404 : code === "invalid_input" ? 422 : code === "read_only" ? 403 : 409;
    if (error instanceof ManagementError && error.currentRevision) details = { revision: error.currentRevision };
  } else if (error instanceof SyntaxError) { status = 400; code = "invalid_json"; message = "Invalid JSON request"; }
  json(response, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}
export async function readBody(request: IncomingMessage, maximum = MAX_JSON_BYTES): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    request.resume(); throw new DashboardError(413, "body_too_large", `Request body exceeds ${maximum} bytes`);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const aborted = () => error(new DashboardError(400, "request_aborted", "Request body was interrupted"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) { cleanup(); request.resume(); reject(new DashboardError(413, "body_too_large", `Request body exceeds ${maximum} bytes`)); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
  });
}
export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new DashboardError(400, "content_type", "Use Content-Type: application/json");
  const bytes = await readBody(request); let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DashboardError(400, "invalid_json", "Invalid UTF-8 JSON request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DashboardError(400, "invalid_input", "Request must be a JSON object");
  return value as Record<string, unknown>;
}
export function textField(value: unknown, field: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DashboardError(400, "invalid_input", `${field} must be a nonempty string (maximum ${max} characters)`);
  return value;
}
