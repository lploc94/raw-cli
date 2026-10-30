import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { commandsFromAcp } from "../src/backends/options.js";
import { slashProvider, type CommandActions } from "../web/src/composer/commands.js";
import type { SuggestionItem } from "../web/src/composer/suggestions.js";

const recorded = (name: string) => commandsFromAcp(
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "backend-commands", `${name}.json`), "utf8")) as AvailableCommand[]);
const claude = recorded("claude");
const codex = recorded("codex");

function actions(disabled?: string) {
  const ran: string[] = [];
  const value: CommandActions = {
    compact: { run: () => ran.push("compact"), ...(disabled ? { disabled } : {}) },
    rename: () => ran.push("rename"), newChat: () => ran.push("new"), details: () => ran.push("details"),
  };
  return { value, ran };
}
const skills = [{ name: "notes", description: "Take notes" }];
const items = (provider: ReturnType<typeof slashProvider>, query = "") => provider.items(query) as SuggestionItem[];
function select(item: SuggestionItem): string[] {
  const replaced: string[] = [];
  item.onSelect({ replace: (text) => replaced.push(text) });
  return replaced;
}

test("a Raw agent's menu is today's: Raw's commands, then the skills, with their actions", () => {
  const { value, ran } = actions();
  const list = items(slashProvider(value, skills));
  assert.deepEqual(list.map((item) => item.label), ["/compact", "/rename", "/new", "/details", "/notes"]);
  assert.deepEqual(list.map((item) => item.id), ["command:compact", "command:rename", "command:new", "command:details", "skill:notes"]);
  for (const item of list.slice(0, 4)) assert.deepEqual(select(item), [""]);
  assert.deepEqual(ran, ["compact", "rename", "new", "details"]);
  assert.deepEqual(select(list[4]!), ['Use the skill "notes" for this task. ']);
  assert.equal(list[0]!.disabled, undefined);
});

test("Claude Code's list: its compact replaces Raw's, its rename/new/details are hidden, the rest follow the skills in its order", () => {
  const { value, ran } = actions();
  const list = items(slashProvider(value, skills, { label: "Claude Code", commands: claude }));
  const hidden = new Set(["compact", "rename", "new", "details"]);
  const rest = claude.filter((command) => !hidden.has(command.name));
  assert.deepEqual(list.map((item) => item.label), ["/compact", "/rename", "/new", "/details", "/notes", ...rest.map((command) => `/${command.name}`)]);
  assert.equal(list.length, 5 + claude.length - 2, "Claude Code lists compact and rename");
  const compact = list[0]!;
  const listed = claude.find((command) => command.name === "compact")!;
  assert.equal(compact.id, "cli:compact");
  assert.equal(compact.description, `${listed.description} · Claude Code`);
  assert.deepEqual(select(compact), ["/compact "]);
  assert.equal(compact.disabled, undefined);
  // Raw's own commands keep their actions.
  assert.deepEqual(list.slice(1, 4).map((item) => item.id), ["command:rename", "command:new", "command:details"]);
  select(list[1]!);
  assert.deepEqual(ran, ["rename"]);
  const context = list.find((item) => item.label === "/context")!;
  assert.equal(context.id, "cli:context");
  assert.equal(context.description, `${claude.find((command) => command.name === "context")!.description} · Claude Code`);
  assert.deepEqual(select(context), ["/context "]);
  assert.ok(!list.some((item) => item.id === "cli:rename"));
});

test("Codex's list: a $ skill is labelled and inserted as $name, and the query finds it", () => {
  const { value } = actions();
  const provider = slashProvider(value, [], { label: "Codex", commands: codex });
  const list = items(provider);
  const skill = list.find((item) => item.id === "cli:$local-skill-1")!;
  assert.equal(skill.label, "$local-skill-1");
  assert.deepEqual(select(skill), ["$local-skill-1 "]);
  assert.deepEqual(select(list.find((item) => item.label === "/status")!), ["/status "]);
  assert.equal(list.filter((item) => item.label.startsWith("$")).length, codex.filter((command) => command.name.startsWith("$")).length);
  assert.equal(items(provider, "local-skill-1")[0]!.label, "$local-skill-1");
  assert.equal(items(provider, "/stat")[0]!.label, "/status");
});

test("Claude Code or Codex without a compact entry: Raw's /compact stays, disabled with the reason; no list means no CLI items", () => {
  for (const commands of [undefined, [], [{ name: "status", description: "Status" }]]) {
    const { value, ran } = actions("Wait for the current work to finish");
    const list = items(slashProvider(value, skills, { label: "Codex", commands }));
    assert.equal(list[0]!.id, "command:compact");
    assert.equal(list[0]!.disabled, "Codex compacts its own context");
    assert.deepEqual(list.slice(5).map((item) => item.label), commands?.length ? ["/status"] : []);
    assert.deepEqual(ran, []);
  }
});

test("a CLI command is disabled neither by Raw's compact state nor by being listed twice in Raw's commands", () => {
  const { value } = actions("Session is loading");
  const list = items(slashProvider(value, [], { label: "Claude Code", commands: [{ name: "compact", description: "Compact" }, { name: "new", description: "New" }] }));
  assert.deepEqual(list.map((item) => item.label), ["/compact", "/rename", "/new", "/details"]);
  assert.equal(list[0]!.disabled, undefined);
  assert.equal(list[2]!.id, "command:new");
});
