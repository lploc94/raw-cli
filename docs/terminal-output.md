# Terminal output

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

Markdown answers support headings, lists, quotes, links, inline code, fenced code, and tables. Known fenced-code languages and structured read-file previews receive syntax highlighting; unknown languages remain plain. Diff signs stay visible. Streaming text appears progressively, including incomplete code fences. Unusually large incomplete blocks may continue as literal text to avoid blocking output. Redirected answers are not reformatted. Tool previews stay bounded and never change tool data sent to the model.

Recognized code languages and path suffixes include JavaScript/JSX, TypeScript/TSX, Python, Bash/sh, JSON/JSONC, YAML, HTML/XML, CSS, SQL, Go, Rust, C/C++, Java, Markdown and diff. Missing or unrecognized labels remain plain code. The renderer processes the current incomplete block rather than replaying the whole conversation; it limits active parser source to 32 KiB and redraws at most 20 rows on a shared terminal. After that bound, it streams literal text until the next stable block boundary. Formatting failures have the same plain-text fallback and do not fail the agent run. A redirected answer keeps the original Markdown bytes.

Footer timing and tool counts describe the current turn. Context is an estimate of the current session's prompt/tool/message size, marked `~`; the percentage is shown only when a context window is configured. Token and cache values describe the cumulative session and appear only when provider coverage supports them. Missing cache counters are unknown, not zero. The continuation command uses the active durable session ID.

The terminal renderer does not affect ACP protocol output. A theme change does not change the model request, cache key, or session schema.
