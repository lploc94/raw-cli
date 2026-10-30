import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { commandsFromAcp } from "../src/backends/options.js";

// The lists claude-agent-acp 0.98.0 and codex-acp 2.3.0 sent on 2026-10-30; skills installed on that machine are renamed.
const recorded = (name: string): AvailableCommand[] =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "backend-commands", `${name}.json`), "utf8")) as AvailableCommand[];

test("commandsFromAcp keeps every command the real CLIs list, in their order, with a hint exactly where there is input", () => {
  for (const [name, size] of [["claude", 67], ["codex", 69]] as const) {
    const list = recorded(name);
    const commands = commandsFromAcp(list);
    assert.equal(commands.length, size, name);
    assert.deepEqual(commands.map((command) => command.name), list.map((command) => command.name));
    assert.deepEqual(commands.map((command) => command.description), list.map((command) => command.description));
    for (const [index, command] of commands.entries()) {
      const hint = list[index]!.input?.hint;
      assert.equal(command.hint, hint || undefined, `${name} ${command.name}`);
      assert.equal(Object.hasOwn(command, "hint"), Boolean(hint), `${name} ${command.name}`);
    }
  }
  assert.ok(commandsFromAcp(recorded("codex")).some((command) => command.name.startsWith("$")));
});

test("commandsFromAcp skips names that are not one token and repeated names, and defaults a missing description", () => {
  const list = [
    { name: "", description: "empty" }, { name: "two words", description: "spaced" }, { name: "line\n", description: "newline" },
    { name: 3, description: "number" }, { name: "status", description: 3 }, { name: "status", description: "again" },
    { name: "review", description: "Review", input: { hint: "" } }, { name: "$skill", description: "A skill", input: { hint: "what" } },
  ] as unknown as AvailableCommand[];
  assert.deepEqual(commandsFromAcp(list), [
    { name: "status", description: "" }, { name: "review", description: "Review" }, { name: "$skill", description: "A skill", hint: "what" }]);
  assert.deepEqual(commandsFromAcp([]), []);
});
