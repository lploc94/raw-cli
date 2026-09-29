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

export const skillInstruction = (name: string) =>
  `Use the skill "${name}" for this task. `;

export function slashProvider(
  actions: CommandActions,
  skills: ComposerSkill[],
): SuggestionProvider {
  const commands: SuggestionItem[] = [
    {
      id: "command:compact",
      label: "/compact",
      description: "Summarize model context while keeping visible history",
      ...(actions.compact.disabled ? { disabled: actions.compact.disabled } : {}),
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
  const all = [...commands, ...skillItems];
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
