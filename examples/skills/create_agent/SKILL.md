---
name: create-agent
description: "Use to create or customize a Raw agent through files or dashboard, with prompt, tools, skills, vars, MCP and policy. Use create-package to distribute an existing setup; configure-raw for one setting."
---
# Create a Raw agent

Use for a new named assistant, a specialized role or a shareable Raw setup. An agent is one agents.<name> entry selecting model, prompt, tools, skills, vars and policy. A session is a saved conversation, not an agent definition. Use `configure_raw` for changing a field of an existing agent.

For how-to, explain the layout; for creation, establish role/name/location/model; for failure, diagnose referenced assets.

## Choose the layout

Personal config: $XDG_CONFIG_HOME/raw/config.json or ~/.config/raw/config.json. Reuse model aliases; preserve other agents/default.

Use `create-package` to distribute an existing setup. Read `references/packages.md` for package authoring and `references/dashboard.md` for browser composition with `read_file`. Copied config directories also work: `agent/<id>` assets travel with the config; `local/<id>` assets do not.

Copy examples/agents/project-helper/ for a forkable layout. This complete example selects a prompt, setup tools/skill and conditional Bash rule. Choose capabilities for the role.

<!-- example:config -->
```json
{
  "default_agent": "writer",
  "models": {
    "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "base_url": "http://127.0.0.1:11434/v1", "context_window_tokens": 32768 }
  },
  "agents": {
    "writer": {
      "model": "local",
      "system_prompt_file": "prompt.md",
      "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"],
        "rules": [{ "match": "builtin/bash", "effect": "ask", "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*rm(\\s|$)" } }] },
      "skills": { "use": ["builtin/configure_raw"] },
      "max_steps": 25,
      "compact": { "keep_recent_turns": 2, "max_output_tokens": 512, "trigger_tokens": 24000 }
    }
  }
}
```

Create `prompt.md` beside `raw.json`, for example:

<!-- example:prompt -->
```markdown
You are a writing assistant. Read the supplied material, draft clear documentation
in the requested format, and distinguish verified facts from assumptions. Preserve
unrelated files. For requests about Raw configuration, list selected skills and
load the relevant guidance. Report the written artifact and checks performed.
```

Replace the model ID and context/compact limits with verified capabilities. `YOUR_INSTALLED_MODEL` is a placeholder, not an advertised model. A recipient provides their own authentication; do not distribute an actual credential as part of the portable example.

## Compose the role and capabilities

Write the prompt in English with role, expected deliverables, scope, working conventions and uncertainty handling. Choose literal `system_prompt` (empty allowed) OR a UTF-8 `system_prompt_file` path, never both. File paths resolve relative to config, not cwd. `--system-prompt` and `RAW_SYSTEM_PROMPT` override the configured prompt. Add list/load routing only when the selected skills help the role; do not paste skill bodies into the initial prompt.

The model alias must exist under `models`. Its required nonempty strings are `provider`, `method` and exact upstream `model_id`. Methods: `openai-chat-completions`, `openai-responses`, `anthropic-messages`, `google-generate-content`. Matching services have supported defaults; custom/gateway pairs need HTTP(S) `base_url`. Credentials may be `api_key_env` or literal `api_key`, not both; an unauthenticated endpoint needs neither. Optional `vision` is boolean; `context_window_tokens` and `max_output_tokens` are positive integers with output below context. Select `builtin/view_image` only with `vision:true`.

Required `tools.use` is ordered and may be empty. Select exact `builtin/<id>`, `local/<id>`, `agent/<id>` or `mcp/server/original-tool-name` IDs; no wildcard discovery. Optional `skills.use` selects unique exact `builtin/`, `local/` or `agent/` skill IDs. Any nonempty skill list requires both skill tools. Only selected folders load, but a missing selected asset blocks startup.

To make a new plugin or skill, use its creation skill only when needed. For existing assets, copying and checking exact IDs is enough. MCP definitions belong to top-level `mcp.servers`; select actual original tool names, not the model-facing aliases. `add_mcp` covers new connection setup.

Policy belongs in this agent's `tools.rules`. Ordered allow/ask/deny rules match canonical IDs, last match wins, unmatched calls run. Conditional ask may inspect a schema-bound string path with an RE2 search pattern. The example uses `commands[*].command` and a direct `rm` pattern; it is textual matching, not complete shell analysis. Ask without an approval channel fails closed. Preserve selective Bash approval rather than prompting for every command. Tools retain full OS permissions.

Optional controls: positive integers `max_steps`, `max_output_bytes`, `request_timeout_ms`; `request` for provider-specific reasoning/output; `cache` for supported hints; `compact` for retention/summarization. Automatic compact requires model context metadata and a `compact.trigger_tokens` leaving output reserve. Consult `configure_raw` for nontrivial provider-specific fields instead of copying another provider's controls blindly.

## Create, verify and share

1. Select a unique name and destination; back up an existing config before adding fields. Keep its mode 0600. For a portable config omit `sessions`, which is canonical-only.
2. Add/reuse the model, create the prompt and selected custom assets, then add the agent with exact IDs. Keep the existing default unless asked; a new standalone file may set its own `default_agent`. `raw --agent writer "query"` selects explicitly; `raw "query"` follows configured selection.
3. Run `raw --config /path/to/raw.json config list`. It verifies schema and references to model aliases, not file contents or live MCP. If the installed library is importable, use `loadConfig({configPath,requireModel:false})` to check the prompt and `createRuntimeTools({runtime,cwd})` to load selected tools/skills and connect selected MCP. Close `tools.mcp` afterward. Otherwise use a harmless task with the intended agent when model access exists and report what remains unverified.
4. For a copied-config share, relocate the directory and repeat loading. For an archive, follow `references/packages.md`: export or author, validate, pack, install, bind a recipient model/inputs and run. Check owned assets, external commands and selected policy with harmless calls. Exclude private session state and machine-specific paths.

Report agent/config/model, selected assets, checks and prerequisites. `raw --resume ID --agent NAME "query"` adopts the current agent on the same conversation; meaningful runtime changes rotate once, while skill changes may add a reload notice. Sharing an agent does not transfer session identity.

## Select and share variables

Root vars/var_providers define values and executable sources; agent.vars selects exact names, omitted means none. Add builtin/list_vars/read_var to tools.use when discovery/reading is needed. Example: root vars.now={description:"Current UTC time",access:"read",source:{kind:"provider",name:"system.time"}}, agent.vars=["now"]. configure_raw covers the full schema; create_tool covers executable providers.

Keep provider scripts/data beside the shared config; command paths, file sources and provider cwd resolve from config, unlike Bash's session cwd. Recipients supply environment values and executable dependencies. Use references for consumption-only values, e.g. commands[].env_refs; do not copy them into the prompt. List/get via raw --config PATH --agent NAME vars needs no model. Repeat after relocating. Runtime values stay out of the initial prefix; old readings are historical on resume. Providers execute on demand, not during listing.
