# Guard hook

Copy this folder to `hooks/guard/` beside your selected `raw.json`, or to `~/.config/raw/hooks/guard/`. Select `agent/guard` or `local/guard` in `agents.NAME.hooks.use`. The gate denies matching `builtin/bash` calls containing a direct `rm` command and reports Bash failures. It is a text filter, not a shell parser; adjust the RE2 pattern for your policy. The script needs Node on PATH. See `docs/hooks.md` for the protocol and a CLI/dashboard smoke recipe.
