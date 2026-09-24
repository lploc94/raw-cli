import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface CapturedRequest { url: string; headers: IncomingMessage["headers"]; body: unknown }
export interface MockResponse { status?: number; frames?: string[]; body?: unknown; hold?: boolean; keepOpen?: boolean }

export async function startMockProvider(responses: MockResponse[]) {
  const requests: CapturedRequest[] = [];
  let closed = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.on("close", () => { closed++; });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    requests.push({ url: req.url ?? "", headers: req.headers, body });
    const response = responses[requests.length - 1] ?? { status: 500, body: { error: "unexpected request" } };
    if (response.hold) return;
    if (response.frames) {
      res.writeHead(response.status ?? 200, { "content-type": "text/event-stream" });
      for (const frame of response.frames) res.write(frame);
      if (!response.keepOpen) res.end();
    } else {
      res.writeHead(response.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body ?? { error: "fixture error" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get closed() { return closed; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}

export function openAiFrame(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

export const openAiDone = "data: [DONE]\n\n";

export function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;
}

export function googleFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
