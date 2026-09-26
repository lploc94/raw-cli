# Terminal output qualification — 2026-09-26

The exact implementation source is commit `0945f1cee89d04e1b74bd122ea523e715cdd71a9` (tree `89e3b7978855df767f2b175131a82cccd8b291ae`). The local packed artifact `raw-cli-0.1.0.tgz` has SHA-256 `fad2531e79e4886fa0ea935e4d4bd3c8362685ac4dd4c7e1e78e0a64ff64fc4a`. This is local mock-provider and renderer qualification, not a hosted-model or GitHub Actions run. The user's installed CLI/config/session store were not changed.

| Gate | Result |
| --- | --- |
| `npm run check` | 368/368 tests passed (`/tmp/raw-terminal-phase6-check1.log`) |
| `npm run test:package` | 2/2 passed (`/tmp/raw-terminal-phase6-package-final.log`) |
| `git diff --check` | Passed before the source commit |
| Shipped `configure_raw` skill | 8,154 bytes, within its 8,192-byte load cap; installed `docs/terminal-output.md` byte-matches source |

The installed-consumer test used `npm pack` and `npm install` in a temporary project outside this checkout. It ran the packed executable through a real PTY against a local mock provider: `read_file` returned `installed-preview.ts`, and both the read preview and streamed fenced TypeScript showed keyword color. The same installed executable then ran with redirected stdout, `--color always`, and ASCII icons; stdout was byte-exact source Markdown with no ANSI in either stream. Existing packed MCP, ACP, skill/tool asset, JavaScript import, and TypeScript consumer checks also passed.

The deterministic gallery ran without config, session state, tools, provider, or network:

```sh
node scripts/preview-terminal.mjs --width 40 --theme light --icons ascii
node scripts/preview-terminal.mjs --width 80 --theme dark --icons unicode
node scripts/preview-terminal.mjs --width 120 --theme terminal --icons unicode --display verbose
```

Representative redirected 40-column excerpt (color absent by design):

```text
[read] read_file  src/example.ts
[ok] read_file  38ms
  0:ok
  0:ok src/example.ts
  export const answer = 42;
* Found

The answer is **42** in
`src/example.ts`.

export const answer = 42;
[ok] Done · 1.2s · 1 tool
  Context  ####------  ~3.4k / 8.2k · 41.5% used
  Session  2.4k input · 180 output · 600 cache read

[continue] Continue this session
  raw --resume 11111111-2222-4333-8444-555555555555 "query"
```

The 80-column dark gallery uses Unicode `↳`, `✓`, `✗`, and `↪` and highlights the retained `src/example.ts` read segment and fenced `ts` answer. The 120-column verbose gallery additionally shows cache/input/output field coverage and ratio. Approval and failure examples display the complete rejected Bash argument and a labeled error; saved-history rendering reproduces the retained read preview. The gallery has a fixed session ID, timings, usage, and source sample, so examples are repeatable.

Actual PTY output was inspected with `NO_COLOR` unset for 40-column light/ASCII and 80-column dark/Unicode themes. The light theme used blue accents, dark green success, red errors, and distinct code colors; the dark theme used bright cyan accents and bright green/red states. With `NO_COLOR=1`, `auto` correctly produced no ANSI. Redirected gallery files had no escape bytes, while both PTY captures had theme-specific SGR sequences. The full UUID resume command remains one copyable line and may soft-wrap on a narrow terminal. Unknown code grammars and unfinished blocks over 32 KiB render as plain text; saved previews remain bounded rather than retrieving full tool output.
