# Add an MCP server to Raw

Use when the user wants an external capability served by MCP. Raw's top-level `mcp.servers` is a catalog of connections; a server definition alone is inert. A named agent activates only exact IDs in its ordered `agents.<name>.tools.use`, written `mcp/<server>/<original-tool-name>`. Do not select `mcp/server/*` or invent tool names. Inspect the selected agent, the server's own documentation or live `tools/list` response, required credentials, and current policy before editing. MCP tools and server processes use the privileges and secrets given to them; the policy controls approval, not isolation.

## Connection schema and selection

`mcp: { "servers": { "name": serverObject } }` is a top-level config object. A stdio server has required `transport: "stdio"` and nonempty `command`; optional `args` is an array of strings and `env` is a string-to-string map. The process is started in the session cwd only when an exact selected tool needs it. A remote server has required `transport: "streamable-http"` and HTTP(S) `url`; optional `headers` is a string-to-string map. Raw currently supports these two config transports. Keep command paths, arguments, URLs and headers valid for the recipient machine. The config does not expand `${VAR}` in `env` or `headers`: supply a private literal value when unavoidable, or let a stdio server read inherited process environment itself. Keep config mode 0600 and do not share secret-bearing files.

`tools.use` must contain `mcp/name/original_name` for each selected tool. The original name comes from the server's `tools/list`, not Raw's stable model-facing alias. Unselected definitions do not start, are not imported into the model context, and do not alter the provider prefix. Raw discovers paginated catalogs, validates selected JSON Schemas and arguments, and closes owned connections on shutdown or failed startup. An unknown server/tool, duplicate server name, unsupported selected schema or failed handshake stops startup before inference. An unsupported **unselected** schema stays inert. ACP `session/new` may also provide discoverable servers; `_raw/session/configure` can later activate a cataloged tool for that session without changing the global config. ACP's standard method names remain unchanged.

## Runnable local stdio fixture

For a no-dependency smoke test, save this as `/absolute/path/echo.mjs` (replace that path with a real absolute path). It speaks newline-delimited MCP JSON-RPC and exposes one `echo_text` tool. Use only for test setup, then replace it with the actual server and exact tool name the user wants:

```js
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "raw-echo", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo_text", description: "Echo text for connection testing", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] };
  else if (request.method === "tools/call" && request.params?.name === "echo_text") result = { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] };
  else if (request.method === "ping") result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
```

This complete example config selects the one server tool for agent `research`. Replace the model ID and the script path; no MCP credentials are needed for this fixture:

```json
{
  "default_agent": "research",
  "models": { "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "base_url": "http://127.0.0.1:11434/v1" } },
  "mcp": { "servers": { "echo": { "transport": "stdio", "command": "node", "args": ["/absolute/path/echo.mjs"] } } },
  "agents": { "research": { "model": "local", "tools": { "use": ["builtin/read_file", "mcp/echo/echo_text"] } } }
}
```

For a real remote server instead, the server object shape is:

```json
{ "transport": "streamable-http", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer REPLACE_IN_PRIVATE_CONFIG" } }
```

Put it under `mcp.servers.search`, then select names actually returned by that server, e.g. `mcp/search/web_search`. A URL is not a tool ID. Do not assume the example endpoint or header value exists. The header map is literal; protect private config and prefer a server's own local credential mechanism where available. MCP result text/structured JSON/image blocks stay typed; a text-only model may use a server that performs OCR and returns **text**, while native image blocks still require a capable selected model/adapter.

## Safe registration and verification

1. Identify the target `agents.<name>` and whether the server belongs in a global or portable config. Back up that JSON at mode 0600. Get the server's real tool names from its documentation or a live MCP `tools/list` call; do not guess from a display alias. For the fixture above, the known name is `echo_text`.
2. Add one `mcp.servers.<name>` object without overwriting other servers. Add exact `mcp/<name>/<tool>` IDs to that agent's ordered `tools.use`; keep its existing selections. `raw config list` should show the selected ID and redact URL credentials, but this alone does **not** prove the server works.
3. Run a harmless task with `raw --config /path/to/raw.json --agent research "echo hello"` against an available model, or use Raw's library `loadConfig` plus `createRuntimeTools` in a local script without provider traffic. Verify connection, catalog lookup and a real call with `{ "text": "hello" }`. Repeat after removing the selected MCP ID: the server must remain inert. If the fixture cannot start, verify `node` on PATH, absolute script path, executable access, protocol output on stdout, and the configured request timeout.
4. Add a `tools.rules` entry only when approval or denial is requested. Match canonical `mcp/echo/echo_text`, not the generated alias; `allow`, `ask` and `deny` are ordered and the last matching rule wins. A conditional `ask` needs a string argument path present in the selected tool's JSON Schema. Test it with a harmless argument; headless `ask` without an approval channel fails closed.

Changing a selected MCP tool's visible schema or selection can advance context revision and rotate Raw's generated cache key on session resume; unselected server edits do not affect the active prefix. A changed config path, agent, model, endpoint or effective prompt can prevent resume entirely. Keep old config files while any important conversation still needs them. Do not add a registry, wildcard expansion, compatibility parser, or background server startup for an unselected definition.
