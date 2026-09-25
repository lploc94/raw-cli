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

`mcp.servers` supports `stdio` with `command`, optional `args` and `env`, or `streamable-http` with `url` and optional `headers`. An agent selects individual original tool names with `mcp/server/tool` IDs in `tools.use`; `"*"` is not an agent selection. Unknown servers and tools fail before inference. Unselected global server processes are never started. ACP `session/new` may supply additional discoverable servers; their tools are initially hidden unless selected by agent ID, and `_raw/session/configure` can explicitly activate cataloged tools later. Duplicate ACP/global server names fail.

The official MCP SDK owns connections and paginated discovery. Raw applies the configured deadline, handles cancellation, and closes owned clients on shutdown or partial startup failure. Selected tools may declare JSON Schema draft-07 or 2020-12; Raw validates arguments with the matching dialect. Selected tools receive stable LLM aliases, but policy matches `mcp/<server>/<original-tool-name>`. Selection and alias ordering are deterministic so repeated requests can reuse prompt prefixes. Tools that are configured but not selected never enter model context.

Text and structured JSON results remain typed. MCP image blocks are separate from MCP vision-to-text: a text-only model can call a vision server that performs image processing itself and returns a text description. Image blocks are passed as typed content by adapters that support them. Unsupported MIME, malformed base64, oversize messages and resource links return explicit errors; Raw does not fetch returned resource URLs.

MCP tools can add browser, search, OCR or managed-process capabilities. The selected server and its own credentials execute those operations; the model receives the returned text or supported typed result. Bash remains a one-shot tool with the user's full OS permissions.

The packaged `examples/agents/project-helper/raw.json` uses only bundled and
config-local assets so it can be copied without an MCP server. To extend it,
declare `mcp.servers.search` in that file and add `mcp/search/web_search` to
the agent's ordered `tools.use` list. The recipient must provide the server
command or URL and any credentials it requires.
