# Connect MCP through the dashboard

Open `raw dashboard` for the intended config and choose **Library → MCP → Edit definitions**. Use the two connection schemas in the main skill: stdio command/args/env or streamable-http URL/headers. Values are literal. Save preserves unrelated config and validates structure.

Choose an agent and the actual server name, then **Discover**. This explicit check resolves even an unselected package MCP definition, connects, lists original tool names, validates advertised schemas and closes the connection. Cancel check owns startup cleanup. Discovery proves handshake/catalog; a harmless server-specific tool call supplies execution evidence.

Select original names and **Add selected tools to agent** for a direct agent. The saved IDs are `mcp/<server>/<original-name>`. Generated model-facing aliases and canonical identities are displayed separately. A package agent needs an explicit complete tools override in **Agents → Agent JSON**, preserving other intended selections.

Configure policy on the agent using canonical identities. A sample rule test performs matching only; matching ask rules surface Allow once/Deny in chat and Activity. It does not create a permanent blanket Bash prompt or change rules after an approval.

Save affects the next turn of an existing session. Use the ordinary session flow or SDK to make a requested harmless call, check results and report any unverified prerequisite. **Library → Packages** can install/share an MCP definition; installing or opening the catalog does not connect it.
