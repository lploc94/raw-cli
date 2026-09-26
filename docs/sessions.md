# Sessions and host operations

CLI, ACP, SDK and dashboard conversations share Raw's session store. Visible history is an ordered record for readers; model context is the current input used for inference. Reading history, renaming a conversation or inspecting metrics does not attach a runtime, claim a writer or renew retention.

The dashboard accepts turns and manual compaction with a client request ID. Acceptance is durable before the response. Repeating that ID with the same submitted intent returns the existing operation, even after completion or restart. Reusing it for different input is a conflict. One session has one writer through startup, execution and cleanup; other sessions may run independently.

An operation progresses from `accepted` through `starting` and `running` or `compacting`, then ends as `completed`, `max_steps`, `cancelled` or `error`. An abandoned operation whose owner is demonstrably gone becomes `interrupted`. It is never automatically resubmitted. The first user message and consumption of the accepted input commit atomically. Tools that may have executed before a crash retain `outcome_unknown`; inspect their effects before requesting another action.

Each turn attaches the selected current agent/config and closes its runtime afterward. An idle browser does not prevent CLI resume. Changed configuration follows the ordinary runtime reconciliation rules; unchanged turns preserve the request prefix. Closing a tab only detaches its view. Stopping an operation aborts its runtime and pending approvals.

Compaction summarizes eligible older model context and retains recent turns. Successful replacement and its visible summary marker commit together; earlier visible history is retained. Manual and automatic attempts expose the same identity and outcomes: `compacted`, `noop`, `not_smaller`, `cancelled` or an error. Byte counts describe serialized context; token counts are explicitly estimates. Loaded skill content removed by compaction keeps the existing reload notice. Compact can affect upstream cache reuse without changing the session ID.

History projections accept existing CLI and ACP envelopes. They preserve record order, tool linkage and available statuses, and label abbreviated previews. Historical output, image bytes, detailed timing or full write diffs may be unavailable; reading current files is not a reconstruction of historical results. No history read executes a tool.

Operation receipts and metrics are optional host records in the same format-5 database, cascade-deleted with their session. They are never injected into the model prompt. An unrelated unsupported legacy database remains isolated by the existing store-location policy.
