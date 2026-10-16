# Verification checklist

- Run the project's own commands: its test script, its typecheck, its build. A focused test file passing is not the
  suite passing.
- Read the exit code, not only the last line of output. Zero exit and a summary line that says how many passed.
- For a bug fix, prove the fix: reproduce the failure first, then show the same check passing. If you cannot reproduce
  it, say so.
- For a behavior change, check the callers you did not write: a passing new test does not prove the old path still works.
- Prefer the claim you can re-run. "I ran `npm test` and it printed 34 passing, 0 failing" beats "tests should pass".
- State the environment when it matters, for example a platform where a check cannot run at all, and name the checks
  that therefore remain unverified.
- Report failures you did not cause by name. Silence about a red test you saw is a false report.
