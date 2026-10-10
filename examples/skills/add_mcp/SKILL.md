---
name: add-mcp
description: "Use when connecting an MCP server for Raw, explaining its binding, or diagnosing tools, including dashboard discovery. Select exact original names and verify live calls. Use create-package to share definitions."
---
# Add an MCP server to Raw

Use when connecting a new MCP capability to a Raw agent or diagnosing that connection. For a how-to, explain connection schema, exact selection and verification. For an actual setup, use the requested server; creating the optional echo fixture below is not a prerequisite or a replacement for that server.

Read `references/packages.md` for package bindings and `references/dashboard.md` for browser discovery with `read_file`.

## Establish the connection

Identify the target config/agent, server command or endpoint, authentication requirements and needed tools. Use the server's actual documentation or `tools/list` to get original tool names. Ask for a missing endpoint/command or required credential source rather than inventing them. For an existing server, inspect its error and definition before replacing it.

Top-level `mcp.servers` is a connection catalog. An agent activates only exact entries in its ordered `tools.use`, e.g. `mcp/search/web_search`. A server definition alone stays inert. Do not select `mcp/server/*` or substitute Raw's generated model-facing alias for the original tool name.

## Connection contract

| Transport | Required | Optional |
| --- | --- | --- |
| stdio | `transport:"stdio"`, nonempty string `command` | `args`: string array; `env`: string-to-string map; `timeout_ms` |
| remote | `transport:"streamable-http"`, HTTP(S) string `url` | `headers`: string-to-string map; `timeout_ms` |

`timeout_ms` (integer 1..2147483647, default the agent's `request_timeout_ms`) bounds connect, tool discovery and each tool call. A call whose server sends progress notifications restarts the timer on each one, so raise it only for tools that work silently for long.

Those are the two configuration transports; unknown fields fail. Stdio starts in the session cwd. Make command/script paths valid for the target machine; a relative script argument is not automatically config-relative. Stdout must carry MCP protocol messages, with logs on stderr. Unselected catalog entries do not start.

`env` and `headers` are literal values: Raw does not expand `${VAR}`. A stdio server can read inherited environment variables through its own authentication mechanism. For a remote endpoint needing a header, obtain a valid private value using the supported setup; do not teach nonexistent interpolation or OAuth configuration fields.

For a remote server, place this object at `mcp.servers.search`; replace the placeholder URL/header, then select exact names returned by that server:

<!-- example:remote-server -->
```json
{ "transport": "streamable-http", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer REPLACE_IN_PRIVATE_CONFIG" } }
```

For example, select `mcp/search/web_search` only if that is a real listed name. The URL itself is not a tool ID. Keep existing agents, servers, defaults and selected tool ordering intact.

## Register and verify the requested server

1. Obtain server-specific command/arguments or URL, check executable/dependency availability, and discover the actual tools. Verify the tool's input schema before choosing test arguments.
2. Back up the config, add one server definition, and append only requested `mcp/<server>/<original-name>` IDs to `agents.<name>.tools.use`. Keep config mode 0600. Follow the canonical/portable path actually in use.
3. Run `raw config list` or `raw --config PATH config list`. This checks structure and selected IDs' syntax; it does not prove handshake, original tool existence or successful execution.
4. If the installed `@tlelabs/raw` library is importable, call `loadConfig({configPath,requireModel:false})`, then `createRuntimeTools({runtime,cwd})`. `tools.mcp.catalog` contains discovered tools; `tools.mcp.exposed` contains selected ones; `tools.warnings` must be empty. Find the selected server/original name there, dispatch its `alias` through `tools.registry.dispatch(alias,args,{cwd,maxOutputBytes:8192})`, inspect the real result, and close `tools.mcp` in `finally`. This does not require a model request. Otherwise run a harmless task with the configured agent when model access is available. Report inability to verify rather than equating config parsing with a live pass.
5. Use a harmless server-specific call. Do not perform writes, purchases or other unrelated side effects just to test the connection. Unselecting the server's tool IDs should leave the definition inert on the next startup.
6. Add a requested policy under this agent's `tools.rules`, matching canonical `mcp/server/tool`, not the alias. Effects are allow/ask/deny, last matching rule wins, unmatched calls run. Only ask permits `when` on a schema-bound string path and an RE2 regex. Verify policy with harmless arguments; headless ask without approval fails closed. Policy does not sandbox the server.

The registry/schema view is fixed for a running CLI session. Editing config does not add a callable MCP alias to that same session automatically; verify the changed configuration through a fresh runtime or next run.

## Optional complete stdio test fixture

Use only when the user wants a reproducible MCP smoke test without installing a real server. Save as an actual absolute `echo.mjs` path. It exposes `echo_text` over newline-delimited JSON-RPC:

<!-- example:server -->
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

Complete config for that fixture; replace both the model ID and script path. Its MCP server needs no credentials:

<!-- example:config -->
```json
{
  "default_agent": "research",
  "models": { "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "base_url": "http://127.0.0.1:11434/v1" } },
  "mcp": { "servers": { "echo": { "transport": "stdio", "command": "node", "args": ["/absolute/path/echo.mjs"] } } },
  "agents": { "research": { "model": "local", "tools": { "use": ["builtin/read_file", "mcp/echo/echo_text"] } } }
}
```

With this fixture, verify a real `echo_text` call with `{"text":"hello"}` returns `hello`. With a different requested server, use its real tool/schema instead.

## Diagnose and report

- Spawn/handshake failure: check command/PATH, cwd, script arguments, stdout protocol and `timeout_ms`.
- Unknown tool/server: check server key and actual original names, including paginated `tools/list`; do not guess from an alias. Raw skips an unavailable selected server or tool with a stderr warning (`unknown MCP tool NAME selected from SERVER; skipped`) and still starts; a server upgrade can rename or drop tools, so replace stale IDs with current names.
- Unsupported selected schema: identify the actual schema error; an unselected unsupported tool is inert.
- Authentication failure: check the server's real credential mechanism and literal headers/environment, not model-provider credentials.
- Image content failure: native images need a capable model/adapter; text-only agents can use OCR tools returning text.

Raw validates selected schemas/arguments and closes connections. Selected changes may rotate the generated key once; unselected edits stay inert. Valid changes resume on the same ID. Missing historical aliases leave saved ACP views, while unavailable current selections are skipped with a warning. Report checks and prerequisites.

Raw vars do not interpolate MCP env/headers or tool arguments. Use a server's inherited environment/auth mechanism, or a local tool consuming context.vars. Executable var_providers use a separate one-request JSON protocol, not MCP.
