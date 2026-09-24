# CLI and REPL contract

`raw "task"` runs one turn and exits. `raw` and `raw --interactive` open a `> ` REPL that keeps one in-memory conversation. `--` ends flag parsing so tasks may begin with `-`. The selected profile, cwd, MCP selections, limits and prompt are fixed when the session starts. No conversation file is written.

The CLI streams assistant text to stdout once, in arrival order. Tool activity and automatic compact progress go to stderr. A completed turn ends with a newline if streamed text did not already end with one. The four REPL commands must occupy a whole line: `/compact` requests an explicit summary using the selected model (possibly in several bounded chunks); `/clear` resets conversation history without resetting usage totals; `/stats` shows cumulative request/token/cache fields and unknown coverage without model traffic; `/exit` closes the session. An unknown slash line is ordinary task text. `compact.trigger_tokens` enables automatic compact before an over-threshold inference; without it, compact remains manual.

All tools execute automatically with the host account's permissions, including on TTY and non-TTY input. `-y`/`--auto-approve` is a compatibility alias. Ctrl-C aborts active work; in a REPL it returns to `> `, and a second Ctrl-C while idle exits. EOF aborts active work and exits after cleanup. One-shot cancellation exits 130.

Exit codes are 0 for completed turns and informational commands, 1 for runtime/provider errors, 2 for argument/config errors, 3 for max steps, and 130 for user cancellation. Recoverable tool errors that the model handles do not set process exit status. Startup and shutdown close owned MCP clients and running shell processes.
