import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { fixtureMcpServer } from "./mcp-server.js";

process.stderr.write("fixture stderr noise\n");
if (process.env.MCP_PID_FILE) writeFileSync(process.env.MCP_PID_FILE, String(process.pid));
if (process.env.MCP_MODE === "crash") process.exit(7);
const server = fixtureMcpServer(process.env.MCP_LABEL ?? "stdio", Number(process.env.MCP_COUNT ?? 2), process.env.MCP_REVERSE === "1",
  process.env.MCP_MODE === "async-schema" || process.env.MCP_MODE === "unsupported-hidden" || process.env.MCP_MODE === "draft7-schema"
    || process.env.MCP_MODE === "numeric-formats-schema"
    ? process.env.MCP_MODE : undefined);
await server.connect(new StdioServerTransport());
