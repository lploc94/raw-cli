# MCP configuration

MCP servers live in the same strict JSON file as models and agents: `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`, or `--config PATH`). A server definition is inert until an agent selects it. There is no separate MCP file or project overlay.

```json
{
  "models": {"local": {"provider":"ollama","method":"openai-chat-completions","model_id":"YOUR_INSTALLED_MODEL"}},
  "agents": {"research": {"model":"local", "tools":{"use":["builtin/read_file","mcp/search/web_search","mcp/vision/describe"]}}},
  "default_agent":"research",
  "mcp":{"servers":{
    "search":{"transport":"stdio","command":"my-search-server","args":[],"env":{}},
    "vision":{"transport":"streamable-http","url":"https://example.test/mcp","headers":{}}
  }}
}
```

`mcp.servers` supports `stdio` with `command`, optional `args` and `env`, or `streamable-http` with `url` and optional `headers`. Either form accepts `timeout_ms` (integer 1..2147483647); it bounds connect, tool discovery and each tool call for that server and defaults to the agent's `request_timeout_ms`. A tool call restarts its timer whenever the server sends a progress notification, so a long call that reports progress is not cut off. An agent selects individual original tool names with `mcp/server/tool` IDs in `tools.use`; `"*"` is not an agent selection. A selected server missing from `mcp.servers` fails before inference. A selected server that cannot start, a selected tool the server no longer lists, or a selected tool whose schema or policy cannot be bound is skipped instead: Raw prints a warning on stderr and the session starts with the remaining tools. Unselected global server processes are never started. ACP `session/new` may supply additional discoverable servers; their tools are initially hidden unless selected by agent ID, and `_raw/session/configure` can explicitly activate cataloged tools later. Duplicate ACP/global server names fail.

The official MCP SDK owns connections and paginated discovery. Raw applies the configured deadline, handles cancellation, and closes owned clients on shutdown, and closes a server that fails its own startup without disturbing the servers already connected. Selected tools may declare JSON Schema draft-07 or 2020-12; Raw validates arguments with the matching dialect. Selected tools receive stable LLM aliases, but policy matches `mcp/<server>/<original-tool-name>`. Selection and alias ordering are deterministic so repeated requests can reuse prompt prefixes. Tools that are configured but not selected never enter model context.

Text and structured JSON results remain typed. MCP image blocks are separate from MCP vision-to-text: a text-only model can call a vision server that performs image processing itself and returns a text description. Image blocks are passed as typed content by adapters that support them. Unsupported MIME, malformed base64, oversize messages and resource links return explicit errors; Raw does not fetch returned resource URLs.

MCP tools can add browser, search, OCR or managed-process capabilities. The selected server and its own credentials execute those operations; the model receives the returned text or supported typed result. Bash remains a one-shot tool with the user's full OS permissions.

The packaged `examples/agents/project-helper/raw.json` uses only bundled and
config-local assets so it can be copied without an MCP server. To extend it,
declare `mcp.servers.search` in that file and add `mcp/search/web_search` to
the agent's ordered `tools.use` list. The recipient must provide the server
command or URL and any credentials it requires.

## Panels

A server may publish a side panel (`raw.panel/2`, [panels design](panels-design.md)) by returning updates in the tool result's `_meta["raw/panel"]`: one update object or an array of them, each `{ "panel": "<id>", "op": "replace" | "patch" | "close", ... }`. Raw validates them exactly like updates from a local tool, keeps them out of the model-visible content and adds only a short confirmation line. Undeclared MCP panels are accepted with an implicit declaration (the title is the document title or the panel id). To give a panel a title, icon or actions, declare it in config: `"panels": [{ "tool": "<original MCP tool name>", "id": "todo", "title": "Todo" }]` on the server (at most four per tool). Panels are owned by the tool's canonical identity (`mcp/<server>/<tool>`, or the package identity for a package-provided server).

An MCP server definition can also come from a package: `"mcp":{"servers":{"web":{"from":"pkg/kit/mcp/search","inputs":{"endpoint":"https://recipient.example/mcp"}}}}`. The local `web` alias remains the selection in `tools.use` (`mcp/web/query`). The package export has its own canonical policy identity (`@owner/name#mcp/search/query`); release labels and artifact hashes do not enter the visible alias. Only selected servers start. Installing, inspecting, exporting or updating the package does not connect to MCP.
