import { existsSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { packageRoot } from "../../package-root.js";
import { BRIDGE_SERVER_NAME, type RawBridge } from "./server.js";

/** The hidden `raw` subcommand the CLI starts as its stdio MCP server. */
export const BRIDGE_PROXY_COMMAND = "__bridge-proxy";

/**
 * Relays MCP between the CLI (stdio) and Raw's bridge (loopback HTTP), unchanged in both directions. The URL and token
 * come from the environment only, never from argv (Invariant 3).
 */
export async function runBridgeProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = env.RAW_BRIDGE_URL;
  const token = env.RAW_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("raw __bridge-proxy needs RAW_BRIDGE_URL and RAW_BRIDGE_TOKEN");
  const upstream = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const local = new StdioServerTransport();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([upstream.close(), local.close()]).then(() => process.exit(0));
  };
  local.onmessage = (message) => {
    upstream.send(message).catch((error: unknown) => {
      // A request that could not reach Raw is answered here, so the CLI does not wait for it.
      if ("id" in message && "method" in message) void local.send({ jsonrpc: "2.0", id: message.id,
        error: { code: -32603, message: `Raw bridge: ${error instanceof Error ? error.message : String(error)}` } });
    });
  };
  upstream.onmessage = (message) => { void local.send(message); };
  local.onclose = close;
  upstream.onerror = () => {};
  await upstream.start();
  await local.start();
  process.stdin.once("end", close);
}

/** How the CLI starts the proxy: this Node and Raw's own entry, with the bridge address in the environment only. */
export function bridgeProxyServer(bridge: RawBridge): { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } {
  const root = packageRoot();
  const built = join(root, "dist", "raw.js");
  // From source (tests, `npm run dev`) the entry is TypeScript and runs through tsx, as Raw itself does there.
  const fromSource = import.meta.url.endsWith(".ts") || !existsSync(built);
  const args = fromSource ? ["--import", import.meta.resolve("tsx"), join(root, "bin", "raw.ts"), BRIDGE_PROXY_COMMAND] : [built, BRIDGE_PROXY_COMMAND];
  return { name: BRIDGE_SERVER_NAME, command: process.execPath, args,
    env: [{ name: "RAW_BRIDGE_URL", value: bridge.url }, { name: "RAW_BRIDGE_TOKEN", value: bridge.token }] };
}
