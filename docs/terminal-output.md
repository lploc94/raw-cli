# Terminal output

When an agent selects hooks, terminal status and saved history show a bounded receipt for every executed hook, including successful empty-output hooks. The receipt names the hook, lifecycle event and outcome; hook input and raw stdout stay out of terminal status. See [hooks](hooks.md).

Raw presents an agent header, streaming Markdown answer, tool activity, and a session footer. The `ui` object at the root of `config.json` controls this presentation. It is independent of an agent's model, prompt, tools, cache, and session identity.

```json
{
  "ui": {
    "density": "normal",
    "reasoning": "summary",
    "color": "auto",
    "icons": "auto",
    "theme": "terminal",
    "palette": { "accent": "cyan", "thinking": "magenta" }
  }
}
```

`density` is `compact`, `normal`, or `verbose`. `reasoning` is `hidden`, `summary`, or `full`; when omitted it defaults to `full` with verbose density and `summary` otherwise. Summary is a host activity label, not a model-generated rewrite of the reasoning. `color` is `auto`, `always`, or `never`; `icons` is `auto`, `unicode`, or `ascii`; `theme` is `terminal`, `dark`, or `light`. The default theme uses the terminal's own foreground and basic palette. Flags `--display`, `--reasoning`, `--color`, `--icons`, and `--theme` override the corresponding config settings. Config validation rejects unknown options and palette roles.

The palette accepts semantic roles `accent`, `text`, `muted`, `thinking`, `path`, `code`, `success`, `warning`, `error`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_type`, and `syntax_punctuation`. Values are basic ANSI color names, their `bright_` variants, or `default`. Raw does not accept escape sequences as color names.

Color and animation are terminal features. Redirected streams, `TERM=dumb`, and disabled color remain plain; `NO_COLOR` affects `auto`. A redirected one-shot stdout contains only the assistant's original text plus the conventional final newline. UI labels, tool activity, errors, context, and continuation use stderr. A piped session command prints history to stdout because history is that command's primary output.

The normal view uses semantic icons: brand `◆`, assistant `●`, read `↳`, write `✎`, Bash `$`, skill `◇`, MCP `↗`, success `✓`, failure `✗`, attention `!`, and continuation `↪`. ASCII mode carries the same states with text labels. Success and failure colors supplement these labels. Custom and MCP tools always have a generic readable fallback.

When both output descriptors refer to the same interactive terminal, Raw may redraw only its unfinished answer line or activity indicator. It clears transient rows before a tool, approval prompt, or error and commits completed answer text once. Separate terminals, redirects, disabled color and dumb terminals use append-only output. The default view keeps successful tool previews short; `--display verbose` reveals the bounded retained body and `--display compact` emphasizes the final answer and errors.

Markdown answers support headings, lists, quotes, links, inline code, fenced code, and tables. Known fenced-code languages and structured read-file previews receive syntax highlighting; unknown languages remain plain. Diff signs stay visible. Streaming text appears progressively, including incomplete code fences. Unusually large incomplete blocks may continue as literal text to avoid blocking output. Redirected answers are not reformatted. Tool previews stay bounded and never change tool data sent to the model.

Recognized code languages and path suffixes include JavaScript/JSX, TypeScript/TSX, Python, Bash/sh, JSON/JSONC, YAML, HTML/XML, CSS, SQL, Go, Rust, C/C++, Java, Markdown and diff. Missing or unrecognized labels remain plain code. The renderer processes the current incomplete block rather than replaying the whole conversation; it limits active parser source to 32 KiB and redraws at most 20 rows on a shared terminal. If either bound is exceeded, it streams that block literally until the next stable boundary. Formatting failures have the same plain-text fallback and do not fail the agent run. A redirected answer keeps the original Markdown bytes.

Footer timing and tool counts describe the current turn. Context is an estimate of the current session's prompt/tool/message size, marked `~`; the percentage is shown only when a context window is configured. Token and cache values describe the cumulative session and appear only when provider coverage supports them. Missing cache counters are unknown, not zero. The continuation command uses the active durable session ID.

The normal footer shows `Done`, `Failed`, `Cancelled`, or `Stopped: max steps`, then elapsed time and started tool calls. Current context appears as an approximate count with a percentage and bar when a window is known. When the estimate reaches the configured compact threshold or effective input budget, the warning names that limit; it never changes the compact decision. Session input/output/cache reads appear only when every request reports the field. Verbose mode and REPL `/stats` show reported-request coverage for each field, including cache writes and the already-defined cache-read ratio. No cache miss or money amount is inferred. A resumable session prints its full `raw --resume ID "query"` command after a successful, failed or interrupted turn; startup/persistence failures do not claim resumability. In REPL mode, turn metrics are compact and the full resume command appears on exit.

`raw sessions show ID` and resume-history playback format retained display records using the current UI settings without re-running tools, opening full model payloads or requesting a model response. A page that begins with a result still shows that result's saved status and name. An alternate `--config` can supply only terminal appearance for history viewing; the selected model's credential is not required for viewing.

The terminal renderer does not affect ACP protocol output. ACP startup does not load the Markdown/highlighting modules; CLI execution and `sessions show` load them only when needed. A theme change does not change the model request, cache key, or session schema.

Developers can inspect fixed, local examples without an API key or config file:

```sh
node scripts/preview-terminal.mjs --width 40 --theme light --icons ascii
node scripts/preview-terminal.mjs --width 80 --theme dark --icons unicode
node scripts/preview-terminal.mjs --width 120 --theme terminal --icons unicode --display verbose
```

Run these in a real terminal to inspect color; redirecting the gallery gives plain text. The gallery uses fixed example records and times, so it does not create sessions or call tools. Newly written display records use session schema 5; older session schemas fail explicitly, with no migration in this development version.
