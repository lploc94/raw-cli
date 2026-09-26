import type { ColorName, PaletteRole, TerminalCapabilities, UiOptions } from "./options.js";

const codes: Record<ColorName, number | undefined> = {
  default: undefined, black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  bright_black: 90, bright_red: 91, bright_green: 92, bright_yellow: 93, bright_blue: 94,
  bright_magenta: 95, bright_cyan: 96, bright_white: 97,
};
const base: Record<PaletteRole, ColorName> = {
  accent: "cyan", text: "default", muted: "bright_black", thinking: "magenta", path: "blue", code: "default",
  success: "green", warning: "yellow", error: "red", syntax_keyword: "magenta", syntax_string: "green",
  syntax_number: "yellow", syntax_comment: "bright_black", syntax_type: "cyan", syntax_punctuation: "default",
};
const light: Partial<Record<PaletteRole, ColorName>> = {
  accent: "blue", muted: "bright_black", thinking: "magenta", path: "blue", success: "green", warning: "yellow",
  error: "red", syntax_keyword: "magenta", syntax_string: "green", syntax_comment: "bright_black",
};
const dark: Partial<Record<PaletteRole, ColorName>> = {
  accent: "bright_cyan", path: "bright_blue", success: "bright_green", warning: "bright_yellow", error: "bright_red",
  syntax_keyword: "bright_magenta", syntax_string: "bright_green", syntax_type: "bright_cyan",
};

export function paint(role: PaletteRole, value: string, ui: UiOptions, capabilities: TerminalCapabilities): string {
  if (!capabilities.ansi || !value) return value;
  const color = ui.palette[role] ?? (ui.theme === "light" ? light[role] : ui.theme === "dark" ? dark[role] : undefined) ?? base[role];
  const code = codes[color];
  return code === undefined ? value : `\x1b[${code}m${value}\x1b[0m`;
}

const symbols = {
  brand: ["◆", "raw"], user: ["❯", ">"], assistant: ["●", "*"], thinking: ["◌", "[wait]"],
  read: ["↳", "[read]"], write: ["✎", "[write]"], bash: ["$", "$"], skill: ["◇", "[skill]"],
  mcp: ["↗", "[mcp]"], generic: ["•", "[tool]"], success: ["✓", "[ok]"],
  failure: ["✗", "[error]"], attention: ["!", "[!]"], continue: ["↪", "[continue]"],
} as const;
export type IconRole = keyof typeof symbols;
export function icon(role: IconRole, _ui: UiOptions, capabilities: TerminalCapabilities): string {
  return symbols[role][capabilities.unicode ? 0 : 1];
}
