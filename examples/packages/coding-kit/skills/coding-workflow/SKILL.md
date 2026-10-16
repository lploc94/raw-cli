---
name: coding-workflow
description: Use for any change in a repository. Survey the code and its tests, agree the acceptance criteria, change one thing at a time, verify with the repository's own commands, and report what actually happened.
---

# Coding workflow

## 1. Survey before you change

Read the code you are about to change and the tests that cover it. Find how the repository already solves the same
kind of problem and follow that pattern. Name the file and line you are relying on, and say so when you are guessing.

## 2. Agree what done means

Turn the request into acceptance criteria with the `goal` tool: each criterion checkable by a command or a specific
observation. If a criterion cannot be checked, it is not a criterion yet.

## 3. One change at a time

Make the smallest change that satisfies a criterion, in the repository's existing style. Keep unrelated refactoring
out of the change. When a file grows or a boundary blurs while you work in it, fix that narrowly instead of broadly.

## 4. Verify with the repository's own commands

Run the project's own build, typecheck and tests, not only the new test you wrote. Read the output and the exit code.
A green run of one file is not a green suite. See [references/verification.md](references/verification.md).

## 5. Report honestly

State what you ran, what it printed, and what you did not verify. Distinguish verified behavior from assumptions, and
put limitations in the report rather than in a footnote. If something failed, say which test failed and why; never
describe a failing command as a success.
