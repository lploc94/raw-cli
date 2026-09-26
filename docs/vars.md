# Runtime variables

Variables are named, read-only external inputs for an agent. Discover metadata
without resolving values, read a value when needed, or pass a reference into a
consuming tool. They are not mutable agent state or an encrypted vault.

## Quick start

A complete config with no external provider dependencies:

```json
{
  "default_agent": "raw",
  "models": { "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL" } },
  "vars": {
    "project": { "description": "Project settings", "access": "read", "source": { "kind": "literal", "value": { "name": "raw-cli" } } },
    "now": { "description": "Current UTC time", "access": "read", "source": { "kind": "provider", "name": "system.time" } },
    "token": { "description": "API credential", "access": "use", "source": { "kind": "env", "name": "MY_API_TOKEN" } }
  },
  "agents": { "raw": { "model": "local", "vars": ["project", "now", "token"], "tools": { "use": ["builtin/list_vars", "builtin/read_var", "builtin/bash"] } } }
}
```

Save as raw.json. `raw --config raw.json vars list` lists selected metadata;
`raw --config raw.json vars get now` reads current time. These commands need no
model credentials, prompt assets, plugin/MCP startup or session storage. Replace
the model placeholder before inference. `raw config init` includes now and both
variable tools for its default raw agent.

## Configuration schema

Root vars and var_providers default to empty objects. Every declaration is
structurally validated; only selected/requested values resolve. Names match
`[a-z][a-z0-9_.-]{0,63}`; constructor and prototype are reserved, and __proto__
is invalid. Duplicate/unknown config fields fail.

Agent `vars` is an ordered array of unique exact root variable names; omitted
means none. No wildcard, automatic exposure or selection inheritance. Select
builtin/list_vars and builtin/read_var explicitly for discovery/reading; a
consumption-only agent can instead know reference names from its prompt.

Each `vars.<name>` has:

| Field | Contract |
|---|---|
| description | Required nonempty string |
| access | Required read or use |
| source | Required discriminated object below |
| type | Optional string, number, boolean, object, array, null or json |
| cache_ttl_ms | Integer 0..2147483647; default 0, resolve every call |

read permits reading and reference consumption. use rejects model and CLI reads
but allows reference consumption. Bash/custom tools have host permissions and
can still print a value; use is not an OS secrecy boundary.

Source fields are exclusive to their kind:

| kind | Fields | Value/type default |
|---|---|---|
| literal | Required value, any JSON | Inferred, including false/0/empty/null |
| env | Required name, environment identifier | String; unset errors, empty is valid |
| file | Required path; optional format text/json, default text | Text preserves whitespace; JSON file defaults to type json |
| provider | Required name; optional params JSON object, default {} | Type json; built-in system.time defaults to string |

File paths resolve relative to config directory, not session cwd. Files must be
regular strict UTF-8 files within 65536 bytes; overflow fails rather than
truncating. Declared types validate resolved values; numbers must be finite.
Env/text/system.time cannot declare a non-string type except json. Provider
params are fixed config data, not model input; recursive references are unsupported.

## Write an executable provider

A provider is any executable implementing one JSON request/response. It has no
tool manifest and is not an MCP server. Root `var_providers.<name>` accepts:

| Field | Contract |
|---|---|
| command | Required nonempty executable name/path |
| args | Optional literal string array, default [] |
| cwd | Optional path, default config directory |
| timeout_ms | Integer 1..2147483647, default 5000 |
| max_output_bytes | Integer 1..1048576, default 65536; combined stdout/stderr |

Bare commands use PATH. Commands containing a path separator and cwd resolve
against config directory; absolute paths stay absolute. Args remain literal and
relative script arguments run from provider cwd. No shell, tilde or template
expansion. The child inherits the resolver environment (normally process.env).
No inline-code field or provider-specific env map exists in v1.

Raw writes one JSON line to stdin, then closes stdin:

```json
{"protocol_version":1,"name":"hostname","params":{"field":"hostname"}}
```

The JSON request is at most 65536 bytes (plus its newline). Return exactly one
JSON object on stdout, with required value and optional observed_at. Unknown
response fields, extra JSON objects or stdout log messages fail. Exit 0 is
required. Logs belong on stderr; Raw counts their bytes but does not return
arbitrary provider diagnostics to the model.

```json
{"value":"workstation","observed_at":"2026-09-26T10:00:00.000Z"}
```

observed_at is valid UTC ISO time with seconds and optional three-digit
milliseconds. If omitted Raw uses completion time. Built-in system.time returns
a UTC ISO string and accepts empty params only; it cannot be overridden by a
user declaration.

Copy the installed `examples/providers/host-info/` directory for a working Node
provider with two configured variables. It uses node:os to return the actual
hostname/platform, requires no network and runs after relocating the folder.
For another language, preserve this protocol and specify its interpreter in
command. A variable provider has fixed parameters; a model-parameterized action
such as arbitrary-location weather lookup is usually a tool instead.

Failures include spawn/stdin/I/O errors, nonzero exit, malformed UTF-8/JSON,
invalid timestamp/type, output overflow, timeout and abort. Errors identify the
variable and failure class without dumping raw provider output. There is no
automatic retry or stale-on-error fallback. Timeout includes process/pipe close.
POSIX cancellation terminates the owned process group with TERM then KILL;
Windows uses direct-child termination. Processes escaping the group are outside
that guarantee. This is not a background job API.

## Model tools and Bash

`list_vars({})` returns `{vars:[{name,description,type,access}]}` only and never
runs a provider. `read_var({name})` returns `{name,value,observed_at,cached}`.
An oversized result returns an output-budget error instead of a partial value.
The selected catalog must fit max_output_bytes when list_vars is selected.

Bash uses references per command, retaining its existing batch shape:

```json
{"commands":[{"command":"test -n \"$TOKEN\"","env_refs":{"TOKEN":"token"}}]}
```

Environment names match `[A-Za-z_][A-Za-z0-9_]*`. Values may be strings, finite
numbers or booleans, converted to string/JSON number/true-or-false. Null,
objects/arrays and NUL are rejected. Bindings override inherited env for that
child only. Raw does not substitute values into shell source or mutate the
model's original arguments.

The registry validates and approves the call first; no extra blanket Bash
prompt is added. Reference metadata for all commands is checked before batch
I/O. Each row resolves its values immediately before starting Bash. A provider
failure stops remaining rows with prior_var_error; prior completed rows are
not rolled back. An actual-type failure for type json is necessarily discovered
at resolution. Existing nonzero-exit continuation and timeout/abort behavior
remain; provider and Bash deadlines are separate, sharing the call's abort signal.

## Custom tool / library API

Every selected local/bundled handler receives optional `context.vars`:

```js
const refs = { TOKEN: args.token_ref };
context.vars.validateEnvRefs(refs); // metadata only
const env = await context.vars.resolveEnv(refs, { signal: context.signal });
const response = await fetch(args.url, {
  headers: { Authorization: `Bearer ${env.TOKEN}` }, signal: context.signal
});
// Return the API response; do not return env merely to prove consumption.
```

`list()` returns metadata; `read(name,{signal}?)` returns a readable resolved
value. `resolveEnv` accepts both access modes and returns only requested env
bindings to trusted code. Handlers imported without a host service must report
vars_unavailable when they require variables. Forked builtin tools receive the
same capability as original tools. MCP receives no automatic refs or env/header
interpolation; its existing literal configuration remains unchanged.

SDK: `loadVariableConfig({configPath,flags:{agent},env})` projects selected
declarations without resolving credentials/prompt assets.
`createVariableResolver({config,env?,now?,monotonicNow?})` creates an independent
service. `createRuntimeTools({runtime,cwd,env?})` owns its resolver at `tools.vars`
and injects it into selected plugins. Close tools.mcp after use as usual.

## Freshness, sessions and model caching

TTL uses monotonic time from successful resolution completion, not observed_at.
Only successes cache; permission checks apply to hits too. Cache is per resolver
instance and stores copies. Concurrent misses may run independently; no in-flight
sharing, proactive refresh, disk cache or cross-session state. CLI get starts
empty each invocation. `/clear` clears conversation but retains the current
runtime resolver's TTL cache.

Tool/system prefixes contain no catalog, values or timestamps. Discovery/reads
append ordinary tool results. Resume creates a fresh resolver with current
config; previous results stay historical. An already running runtime keeps its
validated definitions until restarted, while external values follow TTL. Read
again when freshness matters. Vars-only changes do not rotate generated model
cache keys; selected tool/schema/source changes still follow tool revision rules.
No variable snapshots or resolved env bindings are added to the session DB.
Ordinary returned/printed tool output may of course contain values.

## Diagnose and verify

1. Run config list for strict schema/reference validation; it does not execute sources.
2. Run vars list to check effective agent selection and metadata without resolution.
3. Run vars get for a readable source; get on use-only always fails. Use a nonprinting consuming command to verify use-only bindings.
4. For provider failures check command availability, cwd/args, stdin JSON, stdout purity, exit status, type, time and output limits. Test the script directly to inspect its stderr when needed.
5. Copy a shared config/provider folder elsewhere and repeat. Supply recipient env values/dependencies; do not copy machine credentials into a portable example.

Only --config and --agent apply to vars commands. Success emits one newline-terminated
JSON result. Errors go to stderr: invalid input/config exits 2; resolution/access
failure exits 1; cancellation exits 130. No reveal override or vars write command.

An installed var or executable provider can be bound under a local root name with `{ "from": "pkg/ALIAS/vars/EXPORT", "inputs": {} }` or the corresponding `var_providers` reference. The agent selects the local variable name. Package agent var references (`#vars/NAME` or an exact dependency reference) resolve to selected definitions without reading values during startup or export. `vars list` still returns metadata only; `vars get` resolves the one requested value. Recipient inputs supply source definitions, environment names or paths; they are separate from the runtime readings those sources later produce.
