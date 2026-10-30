import type { BackendCommand } from "../../../src/backends/options.js";
import {
  fuzzyFilter,
  type SuggestionItem,
  type SuggestionProvider,
} from "./suggestions.js";

export interface ComposerSkill {
  name: string;
  description: string;
}

export interface CommandActions {
  compact: { run: () => void; disabled?: string };
  rename: () => void;
  newChat: () => void;
  details: () => void;
}

/** `/` at the start of the draft (after whitespace only) opens the command list. */
export function matchSlash(text: string, caret: number) {
  const before = text.slice(0, caret);
  const found = /^(\s*)\/(\S*)$/.exec(before);
  if (!found) return null;
  return { start: found[1]!.length, end: caret, query: found[2]! };
}

/** A Claude Code or Codex agent's CLI: its label and the commands it lists (none before it is asked). */
export interface CliCommands {
  label: string;
  commands?: readonly BackendCommand[] | undefined;
}

/** Raw's own commands keep these names; the CLI's command of the same name is not listed. */
const RAW_COMMANDS = new Set(["rename", "new", "details"]);

/** A CLI command inserts its text for the user to complete and send; a Codex skill (`$name`) is a mention, not `/`. */
function cliItem(command: BackendCommand, label: string): SuggestionItem {
  const text = command.name.startsWith("$") ? command.name : `/${command.name}`;
  return {
    id: `cli:${command.name}`,
    label: text,
    description: `${command.description || "Command"} · ${label}`,
    onSelect: ({ replace }) => replace(`${text} `),
  };
}

export const skillInstruction = (name: string) =>
  `Use the skill "${name}" for this task. `;

export function slashProvider(
  actions: CommandActions,
  skills: ComposerSkill[],
  cli?: CliCommands,
): SuggestionProvider {
  // On a CLI, `/compact` is the CLI's: Raw does not compact a backend session.
  const cliCompact = cli?.commands?.find((command) => command.name === "compact");
  const compactDisabled = cli ? `${cli.label} compacts its own context` : actions.compact.disabled;
  const commands: SuggestionItem[] = [
    cliCompact ? cliItem(cliCompact, cli!.label) : {
      id: "command:compact",
      label: "/compact",
      description: "Summarize model context while keeping visible history",
      ...(compactDisabled ? { disabled: compactDisabled } : {}),
      onSelect: ({ replace }) => {
        replace("");
        actions.compact.run();
      },
    },
    {
      id: "command:rename",
      label: "/rename",
      description: "Rename this conversation",
      onSelect: ({ replace }) => {
        replace("");
        actions.rename();
      },
    },
    {
      id: "command:new",
      label: "/new",
      description: "Start a new chat",
      onSelect: ({ replace }) => {
        replace("");
        actions.newChat();
      },
    },
    {
      id: "command:details",
      label: "/details",
      description: "Show or hide conversation details",
      onSelect: ({ replace }) => {
        replace("");
        actions.details();
      },
    },
  ];
  const skillItems: SuggestionItem[] = skills.map((skill) => ({
    id: `skill:${skill.name}`,
    label: `/${skill.name}`,
    description: skill.description || "Agent skill",
    onSelect: ({ replace }) => replace(skillInstruction(skill.name)),
  }));
  const cliItems = (cli?.commands ?? [])
    .filter((command) => command.name !== "compact" && !RAW_COMMANDS.has(command.name))
    .map((command) => cliItem(command, cli!.label));
  const all = [...commands, ...skillItems, ...cliItems];
  return {
    id: "slash",
    emptyText: "No matching commands",
    match: matchSlash,
    items: (query) =>
      fuzzyFilter(
        all.map((item) => ({ ...item, label: item.label })),
        query.replace(/^\//, ""),
      ),
  };
}
