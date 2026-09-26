import type { DashboardEvent } from "../../src/dashboard/streams.js";

let accessToken = "";
export function initializeToken(): void {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    accessToken = token;
    try {
      sessionStorage.setItem("raw.dashboard.token", token);
    } catch {
      /* This tab can still work with memory-only authentication. */
    }
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  } else
    try {
      accessToken = sessionStorage.getItem("raw.dashboard.token") ?? "";
    } catch {}
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  return decode<T>(response);
}
async function decode<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.code ?? "request_failed",
      response.status === 401
        ? "Authentication expired. Reopen the launch link printed by raw dashboard."
        : (data.error?.message ?? `Request failed (${response.status})`),
      data.error?.details,
    );
  return data as T;
}
export async function subscribe(
  sessionId: string,
  cursor: string | undefined,
  signal: AbortSignal,
  receive: (event: DashboardEvent) => void,
  connected: () => void,
): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(cursor ? { "Last-Event-ID": cursor } : {}),
      },
    },
  );
  if (!response.ok) {
    await decode(response);
    return;
  }
  connected();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error(
          "Stream disconnected; reconnecting. Your operation can continue on the server.",
        );
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let boundary; (boundary = buffer.indexOf("\n\n")) >= 0; ) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) receive(JSON.parse(data.slice(6)) as DashboardEvent);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function uploadPackage(
  file: File,
  signal?: AbortSignal,
): Promise<import("../../src/dashboard/packages.js").PackageStageView> {
  if (file.size > 128 * 1024 * 1024)
    throw new Error("Package archive exceeds 128 MiB");
  return decode(
    await fetch("/api/packages/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: file,
      ...(signal ? { signal } : {}),
    }),
  );
}
export async function downloadPackage(id: string): Promise<void> {
  const response = await fetch(
    `/api/packages/stages/${encodeURIComponent(id)}/download`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    await decode(response);
    return;
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "raw-package.rawpkg";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
