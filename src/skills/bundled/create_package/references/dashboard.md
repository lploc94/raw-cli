# Share packages in the dashboard

Use **Library → Packages** in `raw dashboard` for the displayed config authority. The package format, input semantics and lifecycle are the same as CLI/SDK.

1. Inspect a local source directory/path or upload a `.rawpkg` (maximum 128 MiB). Review exports, declared inputs, Raw capabilities and external executables. Inspection snapshots and validates files without importing tools or running providers/MCP.
2. Choose an explicit local alias and Install. Installation uses the inspected snapshot and remains separate from default-agent selection. Link authored source instead opts into future changes in the source directory.
3. Use agent chooses a local name, recipient model alias and typed inputs. Defaults are applied by Raw and required inputs are checked for the chosen export. Add component selects a tool/skill on a direct agent or creates a named vars/provider/MCP binding. Package-agent overrides remain complete replacements in Agent JSON.
4. Use Export agent to build a downloadable archive from an existing composition. Include literal variable values and External files to include expose the SDK's explicit decisions; leave them off/empty for recipient inputs. Review the generated report before handing off the archive. The model connection remains recipient-owned.
5. Inspect an updated artifact before Update. Invalid updates preserve the current alias/bindings. Existing sessions resume with the next snapshot. Fork copies into an empty/new authored directory; Remove names dependent bindings, including agent overrides, which must be detached deliberately.

Temporary artifacts are available for review/download/discard for 30 minutes within this server process, with four staging slots. Download the archive before stopping the server. Downloads are ordinary `.rawpkg` files and can be installed after the author's source directory is gone. Building or downloading an artifact is distinct from publishing it to another service; follow the user's requested handoff.
