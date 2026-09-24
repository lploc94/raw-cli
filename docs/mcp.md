# MCP tools

Raw reads MCP configuration from `$XDG_CONFIG_HOME/raw/mcp.json` (or `~/.config/raw/mcp.json`) and then `./raw-mcp.json` in the launch directory. A project server entry replaces the user entry with the same name; entries are never merged field by field. Missing files mean no MCP servers. Invalid JSON or server definitions fail before the agent starts. Remote URLs are connection targets, not executable configuration.

```json
{
  "mcpServers": {
    "local": {"command": "node", "args": ["./tools/server.mjs"], "env": {"MODE": "local"}, "tools": ["search", "read"]},
    "legacy": {"url": "http://127.0.0.1:3001/sse", "transport": "sse", "tools": ["lookup"]},
    "current": {"url": "http://127.0.0.1:3002/mcp", "transport": "streamable-http", "headers": {"Authorization": "Bearer example"}, "tools": "*"}
  }
}
```

Stdio accepts `command`, optional string `args` and string `env` values. Remote servers accept `url`, optional `transport` (`sse` by default, or `streamable-http`) and string `headers`. Each entry must use exactly one transport form. Use a private file or environment-managed process when real header secrets are needed; `raw config list`, runtime info and errors never print header values or URL credentials.

Raw discovers all pages from every configured server. Discovery stays on the host. Only original tool names listed in `tools` are exposed; omitted or empty `tools` exposes none, and `"*"` explicitly selects all. An unknown selected name is an error. Exposed tools get stable aliases prefixed with their server identity; the exact alias maps back to one server and original name. Built-ins remain `read_file`, `write_file`, `bash` in that order, with selected MCP aliases sorted after them. Discovered but unselected tools are absent from the model schema and cannot be invoked by direct dispatch. A session whitelist narrows the exposed set further.

The official MCP SDK owns stdio, SSE and Streamable HTTP connections. Raw uses a configured deadline for connect, discovery and each call; it passes cancellation to the SDK and closes all owned clients on shutdown or partial startup failure. Cancellation prevents late results entering the transcript but cannot prove a remote side effect was reversed. No transport fallback or automatic reconnect loop is attempted after an authentication or server failure.

Text and `structuredContent` are translated to Raw tool-result blocks. If structured JSON duplicates a textual JSON rendering, the JSON block is canonical and the duplicate text is omitted. Additional distinct text is retained under the same output budget. Remote `isError` stays an error. Images with valid PNG/JPEG MIME and base64 are typed image blocks, so provider adapters send native image payloads in the next request. A decoded MCP result or message above 16 MiB is rejected before model submission. Audio, arbitrary binary/PDF, unsupported image MIME and resource links are explicit unsupported-content errors; Raw never fetches a returned resource URL. The separate `max-output-bytes` cap limits model-facing retained content and can replace a large image with a labeled omission preview. A model that cannot accept images receives an explicit unsupported-content error, not a claim that it saw the image.

MCP handles extra capabilities such as browsers or managed interactive processes. Bash remains an ordinary one-shot command and does not provide a persistent background-job API.
