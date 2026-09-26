# Runtime variables

Root `vars` / `var_providers` default to empty objects. Reject unknown fields and duplicate JSON keys using the existing strict config approach. Variable/provider names match `[a-z][a-z0-9_.-]{0,63}`; reserve provider name `system.time`. Reject prototype-sensitive keys with own-property-safe maps consistently. Agent `vars` is an optional ordered array of unique exact existing variable names; no wildcard or implicit inheritance. Variables do not require the two discovery/read tools because a consumption-only agent may know reference names from its prompt.

A variable has required nonempty `description`, required `source`, required `access` (`read` or `use`), optional `type`, and optional nonnegative integer `cache_ttl_ms` (default 0, maximum 2147483647). Supported declared types: `string`, `number`, `boolean`, `object`, `array`, `null`, `json`. Numbers must be finite. `json` accepts any JSON value. Missing type is inferred from literal values, defaults to string for env/text-file, and json for JSON-file/provider; system.time defaults to string. Validate declared type on resolution, and validate literal compatibility at parse time. Omitted metadata does not require executing a provider to infer a type.

Source discriminated union (unknown fields rejected):
- `{kind:"literal", value:<JSON>}`; JSON objects/arrays supported; empty strings, false, 0 and null are values, not missing values.
- `{kind:"env", name:<environment identifier>}`; always produces a string; unset is an error, empty is valid. Reads the resolver's provided environment (default process.env); no eager value copy into runtime config.
- `{kind:"file", path:<nonempty string>, format:"text"|"json"}`; format defaults to text. Path resolves relative to selected config directory. Read strict UTF-8 lazily, preserve text whitespace/newlines, parse JSON only for json format, bound reads to 65536 bytes including oversize detection. Fail on missing/invalid/oversized input, never silently truncate a value.
- `{kind:"provider", name:<provider name>, params?:<JSON object>}`; params defaults to `{}`; no recursive variable references. Name must be `system.time` or a declared executable provider. Built-in system.time accepts only empty params and returns UTC ISO-8601 string.

Executable provider definition: required nonempty string `command`; optional string-array `args` (default []), `cwd` (default selected config directory), positive integer `timeout_ms` (default 5000, max 2147483647), positive integer `max_output_bytes` (default 65536, max 1048576). `max_output_bytes` bounds combined stdout/stderr bytes. Bare commands resolve through PATH; absolute commands stay absolute; commands containing a path separator resolve against config directory. `cwd` resolves against config directory; args remain literal, so relative script arguments resolve from the provider cwd. No shell, tilde or environment expansion. Provider subprocess inherits the resolver environment; no separate inline script or provider-env schema in v1. Provider request JSON is limited to 65536 UTF-8 bytes and validated before spawning.

Example fragment (not an entire config):
```json
{
  "var_providers": {
    "sensor": {"command":"node", "args":["providers/sensor.mjs"], "timeout_ms":5000}
  },
  "vars": {
    "project": {"description":"Project settings", "source":{"kind":"literal","value":{"name":"raw-cli"}}, "access":"read"},
    "github_token": {"description":"GitHub API credential", "source":{"kind":"env","name":"GITHUB_TOKEN"}, "access":"use"},
    "now": {"description":"Current UTC time", "source":{"kind":"provider","name":"system.time"}, "access":"read"},
    "temperature": {"description":"Configured sensor temperature in Celsius", "type":"number", "source":{"kind":"provider","name":"sensor","params":{"field":"temperature_c"}}, "access":"read", "cache_ttl_ms":60000}
  }
}
```
Register names in `agents.<name>.vars`; select `builtin/list_vars` / `builtin/read_var` explicitly in `tools.use` if discovery/reading is wanted.

### Resolver and executable protocol
New small `src/vars/` modules own contract/schema, resolver, and executable supervision. Reuse process lifecycle techniques from `src/tools/process.ts` without pretending provider stdout is a Bash ToolResult. Extract shared low-level supervision only if it removes real duplication without changing Bash's output semantics.

Public host interface `VariableContext`:
- `list(): readonly VariableMetadata[]` returns ordered `{name,description,type,access}` only, fresh copies.
- `read(name, {signal}?): Promise<ResolvedVariable>` enforces read access.
- `validateEnvRefs(refs): void` validates map shape, environment identifiers, selected names, and declared env-compatible types without I/O.
- `resolveEnv(refs, {signal}?): Promise<Record<string,string>>` permits read/use references, validates actual values, and returns only requested environment entries. Trusted plugin code receives these values; model history does not automatically receive them.
- ResolvedVariable is `{name,value,observed_at,cached}`; caller mutation must not mutate future reads/cache.

String/number/boolean values convert to subprocess env as unchanged string / JSON number / `true|false`. Reject null/object/array for env bindings; do not implicitly stringify structured data. For `type:json`, actual-type validation is necessarily deferred until resolution. Env names match `[A-Za-z_][A-Za-z0-9_]*`, reject NUL values; do not restrict names like PATH beyond existing host-permission model. Bindings override the inherited env for that child only.

One request per provider invocation, newline-terminated JSON on stdin followed by EOF:
```json
{"protocol_version":1,"name":"temperature","params":{"field":"temperature_c"}}
```
Exactly one JSON object on stdout (surrounding whitespace allowed), required `value`, optional `observed_at` UTC ISO-8601 string; reject unknown fields, malformed JSON, invalid UTF-8, extra stdout logs/JSON objects, invalid timestamp, and incompatible value types. Exit 0 is required. Absent observed_at uses host completion time; built-in system.time uses one clock sample for value and observed_at. stderr is bounded diagnostic output, not part of the value or model-facing protocol errors. Return stable error codes with provider/variable name and failure class, not raw stdout/stderr or parsed value dumps.

Enforce timeout from spawn through process close, abort-before-spawn, abort while writing stdin, spawn errors, early stdin closure/EPIPE, output overflow and descendant pipe retention. Terminate and reap on failure; retain the repository's POSIX process-group termination and Windows direct-child fallback, documenting the existing platform limit rather than inventing a sandbox. No automatic retry or stale-on-error fallback.

Cache is per resolver instance, bounded by the selected variable catalog, with monotonic expiry measured from successful completion (not provider observed_at). TTL applies uniformly to all sources. TTL 0 always resolves; only successful results enter the cache. No cross-session/process disk cache, proactive refresh, or in-flight request sharing in v1; concurrent misses may execute independently and retain their own cancellation ownership. Permission checks run even on cache hits. `/clear` clears conversation as today; a resolver's TTL cache survives until that runtime is recreated. A CLI get process always starts with an empty cache.

### Tool and surface integration
`createRuntimeTools` creates a resolver per runtime-tools instance and passes its service into `loadToolPlugins`. Extend the existing filtered plugin context with a documented `vars` capability for all selected local/built-in plugins. Standalone plugin imports without host services return a clear vars-unavailable error only when vars are needed. Direct SDK users can create/inject the resolver explicitly through exported types/functions; no module-global singleton or new required arguments for unrelated library use.

New standalone plugins use stable manifests: `list_vars({})` returns `{vars:[metadata...]}`; `read_var({name})` returns ResolvedVariable. Errors use existing ToolResult conventions. A list/read response that cannot fit maxOutputBytes returns a clear output-budget error, never a partially valid value. Validate a selected list_vars catalog can fit at startup without resolving values, consistent with list_skills.

Existing Bash contract becomes:
```json
{"commands":[{"command":"curl -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/user","env_refs":{"GH_TOKEN":"github_token"}}]}
```
The JSON above must be parsed in documentation tests. `env_refs` is optional per command, never a top-level substitute for `commands`. Validate the complete batch's reference metadata before any provider/command side effects, after registry approval. Resolve each command's bindings immediately before that command starts. A resolution/type/NUL failure reports that row as error and skips remaining rows; previous completed rows remain completed. Keep existing nonzero-exit continuation and timeout/abort stopping behavior. Record a clear skip reason such as `prior_var_error` rather than mislabeling it `prior_timeout`. A denied/invalid call runs neither provider nor Bash. The command's timeout_ms remains its Bash execution deadline; variable providers use their own deadline and the same call abort signal.

No special MCP argument rewriting. Existing MCP inputs/results and selection remain unchanged; tools capable of env references are local handlers using context.vars. This boundary must be explicit in add_mcp and tools docs.

CLI `raw [--config PATH] [--agent NAME] vars list|get NAME` uses effective agent selection, validates the config, and does not require LLM credentials, load prompt files, import plugins, start MCP, open a session DB or make inference requests. Factor selection/config projection rather than routing through full runtime startup. Output one newline-terminated JSON result using the same catalog/value shape; errors to stderr, exit 2 for invalid invocation/config and 1 for resolution/access failure, 130 for cancellation. No get override to reveal use-only values. Reject incompatible task/session/ACP flags. `config list` shows selected variable names only.

`config init` adds root `vars.now`, agent raw selection `["now"]`, and both variable tools alongside existing setup tools; static prompt can mention list/read discovery but must not embed catalog/value data. Other agents require explicit edits; do not auto-append tools to user definitions.

Session behavior is deliberately simple: no vars snapshot/digest/visibility fields. Prior tool results retain their observed_at and remain historical even if config/provider code changes. A new runtime uses current definitions; an existing runtime holds validated definitions until restarted. External env/files/providers resolve according to TTL. Manifest descriptions teach the model to read again when fresh data matters, especially after resume. Tests must prove repeated resumes do not execute providers until used and variable changes alone preserve system/tools/cache key.

