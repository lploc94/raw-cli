# Configure Raw in the dashboard

Use this reference for a browser workflow; the main skill also covers direct file and CLI changes.

Start `raw dashboard --config PATH` for the intended config, or omit `--config` for the canonical config. The displayed path is the authority. Workspace selection changes runtime cwd. Keep the foreground process running; the printed launch URL authenticates the browser.

- **Settings → General** selects the default agent. Missing config can Initialize Raw with the shared seven-skill starter. Invalid existing JSON has an explicit repair editor.
- **Models & connections** edits provider/method/model ID, endpoint, credentials, context/output limits and vision. Credentials have Keep, Set or Clear actions. Saving validates structure; Start test chat opens the ordinary composer, and Send performs inference.
- **Agents** owns prompts, ordered selections, conditional rules, request/cache/compact settings and package overrides. Agent JSON exposes supported advanced fields.
- **Library → Vars** edits `vars` and `var_providers`. Read is an explicit check using the selected agent's access rules. **Library → MCP** saves definitions and explicitly discovers tools.
- **Appearance** and **Chat & keyboard** are browser preferences, separate from terminal `ui` config fields. **Sessions & storage** edits retention only at the canonical config; an alternate-config dashboard displays that location without writing it.
- **Diagnostics & advanced** opens full strict JSON into editor memory. Diagnostic copy contains allowlisted metadata. Port and listener settings are startup flags and require a restart.

Save applies on the next turn, including an existing session. Save/Discard and Ctrl/Cmd-S operate on the active editor. A stale revision preserves the draft: review the latest content, then reload or reapply explicitly. Retain fields outside the requested change. The server has the invoking user's OS permissions; cwd is not a sandbox.

Report static validation separately from successful model, variable or MCP execution. Use the Context inspector after a turn for measured/estimated usage and the model's declared window; opening Settings does not measure model use.

For hooks, open Library → Hooks to inspect or edit `hook.json` and owned scripts. Attach the exact ID to one agent under Selected hooks; order matters. Catalog validation does not run the command. Check the event, canonical tool match, RE2 `when`, command/args and timeout before saving. Chat and History show bounded hook receipts after a matching event; a stale revision preserves the draft.
