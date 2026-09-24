# MCP configuration

MCP servers live in the same strict JSON file as models and profiles: `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`, or `--config PATH`). A server definition is inert until a profile selects it. There is no separate MCP file or project overlay.

```json
{
  "models": {"local": {"provider":"ollama","method":"openai-chat-completions","model_id":"YOUR_INSTALLED_MODEL"}},
  "profiles": {"research": {"model":"local", "mcp":{"search":["web_search"],"vision":"*"}}},
  "default_profile":"research",
  "mcp":{"servers":{
    "search":{"transport":"stdio","command":"my-search-server","args":[],"env":{}},
    "vision":{"transport":"streamable-http","url":"https://example.test/mcp","headers":{}}
  }}
}
```

`mcp.servers` supports `stdio` with `command`, optional `args` and `env`, or `streamable-http` with `url` and optional `headers`. Each profile's `mcp` map selects named servers and either an exact list of original tool names or `"*"`. Missing or empty `mcp` selects none. Unknown server names fail config validation; unknown selected tool names fail discovery before inference. Unselected server processes are never started. ACP `session/new` MCP definitions are explicit session selections and follow the same tool policy.

The official MCP SDK owns connections and paginated discovery. Raw applies the configured deadline, handles cancellation, and closes owned clients on shutdown or partial startup failure. Selected tools receive stable LLM aliases, but policy matches `mcp:<server>/<original-tool-name>`. Selection and alias ordering are deterministic so repeated requests can reuse prompt prefixes. Tools that are configured but not selected never enter model context.

Text and structured JSON results remain typed. MCP image blocks are separate from MCP vision-to-text: a text-only model can call a vision server that performs image processing itself and returns a text description. Image blocks are passed as typed content by adapters that support them. Unsupported MIME, malformed base64, oversize messages and resource links return explicit errors; Raw does not fetch returned resource URLs.

MCP tools can add browser, search, OCR or managed-process capabilities. The selected server and its own credentials execute those operations; the model receives the returned text or supported typed result. Bash remains a one-shot tool with the user's full OS permissions.
