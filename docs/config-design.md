# Configuration design

`raw-cli` has not been released. Its config is a strict, breaking JSON contract; no flat-profile parser, migration alias or compatibility shim is retained. The runtime reads one file from `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`), overridden by `--config PATH`. Duplicate and unknown fields fail before a connection starts.

## Ownership

| Section | Owns | Does not own |
|---|---|---|
| `models.<alias>` | One exact upstream access path: service, API method, model ID, endpoint, selected credential source, context/output metadata, vision | Run-specific tool permissions or compact policy |
| `profiles.<alias>` | One runnable selection of a model plus request controls, cache, compact, MCP selection, tool rules and limits | A second model or implicit mid-session fallback |
| `mcp.servers.<name>` | An inert external connection definition | Model-facing exposure until a profile selects its tools |

`provider` names the company or deployment (`deepseek`, `openai`, `anthropic`, `ollama`, or a custom gateway). `method` chooses the wire API and official SDK adapter: `openai-chat-completions`, `openai-responses`, `anthropic-messages`, or `google-generate-content`. `model_id` is sent upstream verbatim as the request's model value. A local alias such as `flash` is never substituted for it. Multiple profiles may refer to the same model, with different effort, output, cache, compact or tool policy.

An entry may use `api_key_env` or literal `api_key`, never both. Only the selected model resolves its environment credential. A custom service/method pair needs an explicit `base_url`; a selected known service may use its verified default. `raw config list`, ACP runtime info and errors redact credential values. No request option may override model ID, tools, endpoint or credentials.

## Capability and tools

Text and ordinary function/tool calling are assumed. `vision: true` on a model opts into the local `view_image` tool. It is omitted for a text-only model, leaving exactly `read_file`, `write_file`, and `bash` as the built-ins. The user can name an image path directly in a task; there is no CLI image flag. Native PNG/JPEG results are delivered through the selected method adapter. Search and external vision-to-text are supplied through selected MCP tools; a text-only model receives only their textual descriptions, not raw image bytes.

The `mcp.servers` map is separate from profile exposure. A profile's `mcp` map selects original tool names (`["web_search"]`) or all tools (`"*"`) from named servers. Unselected servers never start. Profile `tools.rules` is an ordered array of `{ "match": pattern, "effect": "allow" | "ask" | "deny" }`. Last matching rule wins; no match means `allow`. Built-in identities are tool names, MCP identities are `mcp:server/original_tool`, and ACP-injected identities are `acp:name`. `ask` requires a TTY or ACP permission channel and is never bypassed by `-y`. These rules select handlers; `cwd` and rules do not provide OS isolation. `bash` keeps the invoking user's full OS permissions.

## Context and cache

`context_window_tokens` is user-supplied model metadata. A profile's `request.max_output_tokens` and `compact.max_output_tokens` are distinct: the former caps an ordinary model response, the latter caps summary responses. Without `compact.trigger_tokens`, compact is manual. With it, Raw estimates the full upcoming request including system, tools, transcript, opaque state and image bytes; it can summarize older turns in bounded chronological chunks before inference. Summary prompts represent older images as path/MIME/size metadata, never base64. Every chunk and the post-compact main request is rechecked against the declared context, output reserve and safety margin. Estimates are not exact provider token counts.

The normal system/tool/history prefix and selected tool order remain stable across turns for potential prompt-cache reuse. A deliberate compact rewrites history and uses a separate summary cache key; it does not claim a hit. Cache hints and usage parsing are method/service-specific. See [configuration](configuration.md), [providers](providers.md), and [context](context.md) for exact fields and limits.

## Example

```json
{
  "default_profile": "deepseek",
  "models": {
    "flash": {
      "provider": "deepseek",
      "method": "openai-chat-completions",
      "model_id": "deepseek-flash",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY",
      "context_window_tokens": 1048576
    }
  },
  "profiles": {
    "deepseek": {
      "model": "flash",
      "request": { "thinking": "enabled", "reasoning_effort": "high", "max_output_tokens": 4096 },
      "compact": { "trigger_tokens": 800000, "keep_recent_turns": 2, "max_output_tokens": 512 },
      "tools": { "rules": [{ "match": "mcp:unsafe/*", "effect": "deny" }] }
    }
  },
  "mcp": { "servers": {} }
}
```
