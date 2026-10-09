# Contributing to raw-cli

Thanks for helping improve Raw. Bug reports, documentation fixes and focused pull
requests are all welcome.

## Development setup

Requires Node.js 22.13+ and Bash.

```sh
git clone https://github.com/lploc94/raw-cli.git
cd raw-cli
npm ci                      # installs dependencies and builds dist/
npx playwright install chromium   # npm run check drives the dashboard in Chromium
npx playwright install firefox webkit   # also needed for npm run test:web
```

## Checks

Run the same gates as CI before opening a pull request:

```sh
npm run check               # typecheck + build + unit and integration tests
npm run test:overhead
npm run test:package
npm run test:web            # dashboard browser tests
```

Tests use local provider, MCP and ACP fixtures; they do not need API keys.

## Pull requests

- Keep each pull request to one change and describe the behaviour it changes.
- Add or update tests next to the behaviour you change, and update `docs/` when a
  user-visible contract changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style subjects,
  for example `fix(dashboard): keep scroll position after approval`.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
