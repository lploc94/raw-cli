# Session continuity and portable package qualification

The first milestone's session-specific evidence is in [milestone-a-session-continuity.md](milestone-a-session-continuity.md). The package milestone uses the same session IDs and runtime transition code; package installation never reads or upgrades a session database.

## Installed consumer witness

`tests/package-sharing-installed.test.ts` runs through `npm pack`, installs the tarball in a temporary consumer project, and invokes only that project's `node_modules/.bin/raw` or its installed `raw-cli` SDK. It copies the installed `examples/packages/mixed-kit/` source to a separate author directory, packs an archive, installs it under the recipient's distinct XDG config/data/state homes, and removes the author source before the first recipient task. The witness also packs and installs the standalone tool-only and skill-only examples. The source checkout supplies the test driver and mock HTTP provider, but the recipient binary and SDK do not import code from that checkout.

The recipient starts with an unreadable schema-4 legacy database. Its bytes remain unchanged, while a new session is created in the format-5 family and keeps its ID through package updates. The mixed package's helper-backed tool, selected skill list/load, lazy var provider, stdio MCP tool and prompt all reach actual model requests/results. A changed prompt/helper/skill/provider archive is attached on resume; the next unchanged resume retains the new cache key and serialized request prefix. A release-label-only update retains that same key and prefix. Fork/link edits and individual tool/skill selections work after the author source is gone. The installed SDK declaration check covers package lifecycle and agent binding APIs.

The 2026-09-26 development witness before the phase-8 commit recorded source base `07374b112ceda5e03598aec89c3e1f1bdc0053f6` plus the phase-8 working tree, archive SHA-256 `25c59b98995962420c68142c9dd60cf8daa74df0c5e7a20160e6cf84ec92ecd5`, an installed binary at `/var/folders/_x/8bhwgz2d0m12ddzdfw27jjtc0000gn/T/raw-package-installed-JVHoId/consumer/node_modules/.bin/raw`, and 7 mock HTTP requests. That temporary prefix was removed by test cleanup. The witness prints the exact archive digest, source commit and temporary binary path on every run. Final committed-source qualification is recorded after the phase-8 commit.

## Verification and limits

During phase 8, `npm run test:package` passed all three packed-consumer suites and `npm run check` passed 462 tests. `tests/setup-skill-examples.test.ts` validates all five English setup skill bodies against the 8 KiB load cap, their shipped package references and the six-export mixed example; its existing concrete schema examples also pass. `git diff --check` passed. Final HEAD gates are rerun after the phase commit and entered below.

These runs used macOS and local mock model/MCP/provider endpoints. They establish no Windows or Linux runtime qualification, hosted marketplace, automatic Git transport, signature verification service or live paid-provider cache-hit claim. Cache evidence concerns Raw's generated key and serialized outgoing prefix; provider-side cache reuse was not asserted.
