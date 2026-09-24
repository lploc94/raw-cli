# Architecture and state ownership

`raw` keeps model-facing input small. The ordinary request contains one literal system prompt, selected tool schemas, the user's messages, and committed assistant/tool history. Configuration, provider discovery, logs, approval text, and usage statistics stay in host state. Tool schemas are measured together with the prompt, not mistaken for free context.

The configuration loader resolves one named LLM profile per session. Provider adapters stream through official SDKs into a small common event shape. The agent loop owns transcript and step count. The registry owns schema validation, exposure and authorization before execution. External MCP tools join that registry only when explicitly selected. ACP owns independent session state and protocol transport. The CLI renders events and obtains approvals but does not reimplement the agent loop.

Committed conversation blocks do not change between ordinary turns; new user messages and tool results append. This preserves reusable cache prefixes. A failed or cancelled tool batch must retain valid call/result linkage. Explicit `/compact` atomically replaces eligible older history with a labeled summary and resets the rewritten cache prefix; `/clear` discards history while idle. Both operations leave the three primitive definitions unchanged.

One inference request counts as one step. The default maximum is 25. When the last allowed request asks for a tool, the run stops before that tool executes because it cannot consume the result in another inference step. Compact is an explicit separate inference operation.

`raw` has full permissions of its invoking OS account. Session cwd resolves relative file paths and shell working directories, without limiting access to absolute paths. Approval and whitelists decide which registered handlers raw will dispatch; they are not OS isolation mechanisms.
