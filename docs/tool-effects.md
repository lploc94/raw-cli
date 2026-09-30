# Tool inspection contract

Raw's current development contract is `raw.tool-api/2`, `raw.panel/2` and `raw.hook/2`. Formats are replaced directly during development; Raw does not migrate or adapt obsolete tool manifests, hook payloads or conditional predicates.

Tool arguments are the original validated input. Intended effects are separately prepared metadata describing what a call intends to change. They are not completed outcomes, substituted arguments, or an OS security boundary.

## Declaration and preparation

A tool manifest declares `condition_sources`, an array of allowed sources (`arguments`, `effects`). A tool supporting effects also declares an object `effects_schema` and exports `describeEffects(args, {cwd})`. Effects descriptors must perform bounded parsing and lexical normalization only, without file reads, providers, shell execution or mutations. Their implementation is trusted code, like an argument validator.

The registry checks exposure and unconditional denial, validates the entire input, prepares and validates effects, then evaluates conditional policy, runs PreToolUse, requests approval when needed, and invokes the handler. Descriptor errors and invalid effects stop the call before the handler. Arguments and effects are immutable for dispatch. Hooks and approval see the prepared effects separately; provider input and persisted model arguments remain the original arguments.

Descriptors return synchronously. Promise/thenable results are rejected and their rejection is observed without awaiting them. The exact bounded JSON snapshot supplied to policies, hooks and handlers is schema validated after serialization. Registry registrations enforce their full input schema alongside any semantic validator before preparing effects. Hook sources are rebound before publishing a changed tool view, including newly exposed ACP and MCP tools; an unavailable effects source cannot silently skip a gate.

Write declares effects-only conditional inspection. Its descriptor emits `files`, each containing an absolute lexically normalized `path` and an `operation` (`write`, `delete`, `rename_source`, `rename_destination`). Every operation and patch target is covered; a rename includes both paths. A symlink is not resolved by this projection. The handler's parsed targets must agree with the inspected targets.

## Predicates

Every conditional predicate declares its source explicitly:

```json
{"source":"effects","any":"files[*].path","regex":"protected\\.txt$"}
```

`any` binds to a string field in the selected source schema. Unsupported sources, undeclared effects and missing source fields are validation errors. Optional fields absent from a valid value do not match. Rule ordering and last-match behavior apply normally. Policies and hook subscriptions share the same binder and evaluator. Command conditions use `source: "arguments"` and `commands[*].command`.

## Approval and hooks

An approval callback receives one request object containing identity, name, arguments, optional effects, toolCallId and signal. The UI shows intended files separately from raw input. Approval never mutates arguments or turns intended effects into successful outcomes.

Hook manifests declare `protocol_version: 2`. Tool event payloads contain `tool.arguments` and optional `tool.effects`. Conditions inspecting effects use that separately declared schema. No v1 callback, payload or predicate adapter is provided.

## UI declarations

All panel contexts report protocol 2. A declaration has `placement: "chat" | "sidebar"`, default sidebar. The same block catalog is used at either location. Form blocks have text, single-select or multi-select fields; response actions submit/cancel a pending request and do not grant execution permission. Mermaid blocks carry bounded source, with source/text fallback when rendering is unavailable. Interactive request service and diagram rendering are implemented in later phases of the plan.

Host-owned `ToolViewIdentity` records an opaque `instanceId`, run/call, owner and declaration, plus session/operation when durable. `InteractionRequestIdentity` adds a `requestId` and optional inline `viewInstanceId`. Clients submit `InteractionResponseSubmission` with request ID, expected revision, idempotency key and either answers or cancellation; the host derives ownership from the stored request. The acknowledgement records the terminal state, revision and exact canonical accepted result. These identifiers are host envelopes, never tool-authored document fields.
