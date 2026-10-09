# Security policy

## Supported versions

Security fixes land on the latest release and the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
[GitHub security advisories](https://github.com/lploc94/raw-cli/security/advisories/new)
with steps to reproduce, the affected version and the impact you observed. You should
receive an acknowledgement within a few working days.

## Scope

Raw runs tools with your operating-system account's full permissions; `cwd` is not a
sandbox. Behaviour that follows from an agent's configured tools and `tools.rules` is
expected. Reports are in scope when Raw bypasses an explicit `ask` or `deny` rule, leaks
credentials (for example into logs, sessions or packages), lets a package or dashboard
request act outside its documented contract, or exposes the dashboard or ACP WebSocket
beyond the local host without being told to.
