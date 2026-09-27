# Configuration and component editing

The component manager treats hooks as editable owned folders alongside tools and skills. A hook has `hook.json` and its script assets; dashboard create, fork, edit, selection and deletion use the same revision and in-use guards. Browsing a hook only validates files. See [hooks](hooks.md) for the command protocol and event list.

The dashboard manages one displayed Raw config path. Runtime configuration remains strict JSON on disk. Browser drafts and appearance preferences are not another configuration layer. Model credentials use explicit keep/set/clear edits; an advanced raw-config editor is an explicit full-document read.

Managed saves carry the content revision from their read. Raw writers share an owned file lock, reread and validate the candidate at its actual config location, then atomically publish a private file. A stale revision returns a conflict without discarding the user's draft. External text editors do not share Raw's lock; Raw compares bytes again before publication without claiming a universal filesystem compare-and-swap. Unknown-to-form fields and ordered selections are preserved. A raw JSON repair save may replace an invalid document after revision checking.

Configuration initialization uses the same starter factory as `raw config init`, including the `raw` agent and seven setup skills. Initialization never overwrites an existing file. Model credentials are not required to inspect or edit setup. Session retention belongs only in the canonical global config; a dashboard managing an alternate config cannot write that setting into it.

Component catalogs read manifests, Markdown and owned text files without importing a tool, evaluating a variable provider, connecting MCP or calling a model. Invalid entries have individual diagnostics. Successful static validation is not a successful live connection or tool execution.

Builtin and installed immutable package files are read-only. Fork to a new local/config-adjacent component before editing; linked packages retain their editable authored source. Source-file saves use their own revisions, validate affected manifests/Markdown and publish one file atomically. Creation/clone validates a staged directory and publishes a new component ID. Attaching it to an agent is a separate config save; a failed attachment leaves a valid unselected component.

The editor accepts contained relative file paths under inspected component handles. It refuses paths and symlinks escaping the owned component. It is not an arbitrary filesystem browser or a runtime sandbox. Deleting an asset reports usages in the displayed config and requires detaching them first; it never recursively rewrites other configs or deletes historical sessions.

Agent, model, var/provider and MCP edits use their existing schemas. Package bindings retain explicit whole-block overrides. Policy sample matching evaluates canonical identity and argument patterns without executing a command. Saving applies to the next turn; it does not mutate an already running runtime or require a new session.
