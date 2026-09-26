export const COLOR_NAMES = ["default", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright_black", "bright_red", "bright_green", "bright_yellow", "bright_blue", "bright_magenta", "bright_cyan", "bright_white"] as const;
export type ColorName = typeof COLOR_NAMES[number];
export const PALETTE_ROLES = ["accent", "text", "muted", "thinking", "path", "code", "success", "warning", "error",
  "syntax_keyword", "syntax_string", "syntax_number", "syntax_comment", "syntax_type", "syntax_punctuation"] as const;
export type PaletteRole = typeof PALETTE_ROLES[number];
export type Density = "compact" | "normal" | "verbose";
export type ReasoningDisplay = "hidden" | "summary" | "full";
export type ColorDisplay = "auto" | "always" | "never";
export type IconsDisplay = "auto" | "unicode" | "ascii";
export type ThemeName = "terminal" | "dark" | "light";
export interface UiInput {
  density?: Density;
  reasoning?: ReasoningDisplay;
  color?: ColorDisplay;
  icons?: IconsDisplay;
  theme?: ThemeName;
  palette?: Partial<Record<PaletteRole, ColorName>>;
}
export interface UiOptions {
  readonly density: Density;
  readonly reasoning: ReasoningDisplay;
  readonly color: ColorDisplay;
  readonly icons: IconsDisplay;
  readonly theme: ThemeName;
  readonly palette: Readonly<Partial<Record<PaletteRole, ColorName>>>;
}
export interface TerminalCapabilities { readonly tty: boolean; readonly ansi: boolean; readonly unicode: boolean; readonly cursor: boolean }

const choices = {
  density: ["compact", "normal", "verbose"],
  reasoning: ["hidden", "summary", "full"],
  color: ["auto", "always", "never"],
  icons: ["auto", "unicode", "ascii"],
  theme: ["terminal", "dark", "light"],
} as const;

export function validateUiFlag(name: keyof typeof choices, value: string): void {
  if (!(choices[name] as readonly string[]).includes(value)) {
    throw new Error(`invalid ui.${name} / --${name === "density" ? "display" : name}; expected ${choices[name].join(" | ")}`);
  }
}

export function parseUiDocument(raw: unknown): UiInput {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ui must be an object");
  const data = raw as Record<string, unknown>;
  const result: UiInput = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "palette") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ui.palette must be an object");
      const palette: Partial<Record<PaletteRole, ColorName>> = {};
      for (const [role, color] of Object.entries(value)) {
        if (!(PALETTE_ROLES as readonly string[]).includes(role)) throw new Error(`unknown ui.palette role ${role}`);
        if (typeof color !== "string" || !(COLOR_NAMES as readonly string[]).includes(color)) throw new Error(`invalid ui.palette.${role} color`);
        palette[role as PaletteRole] = color as ColorName;
      }
      result.palette = palette;
    } else if (Object.hasOwn(choices, key)) {
      if (typeof value !== "string") throw new Error(`ui.${key} must be a string`);
      validateUiFlag(key as keyof typeof choices, value);
      (result as Record<string, unknown>)[key] = value;
    } else throw new Error(`unknown ui field ${key}`);
  }
  return result;
}

export function resolveUiOptions(document: UiInput = {}, flags: UiInput = {}): UiOptions {
  const density = flags.density ?? document.density ?? "normal";
  const palette = Object.freeze({ ...(document.palette ?? {}), ...(flags.palette ?? {}) });
  return Object.freeze({ density, reasoning: flags.reasoning ?? document.reasoning ?? (density === "verbose" ? "full" : "summary"),
    color: flags.color ?? document.color ?? "auto", icons: flags.icons ?? document.icons ?? "auto",
    theme: flags.theme ?? document.theme ?? "terminal", palette });
}

export function terminalCapabilities(tty: boolean, env: NodeJS.ProcessEnv, ui: UiOptions): TerminalCapabilities {
  const eligible = tty && env.TERM !== "dumb";
  const ansi = eligible && ui.color !== "never" && (ui.color === "always" || !env.NO_COLOR);
  const unicode = ui.icons === "unicode" || (ui.icons === "auto" && eligible);
  return { tty, ansi, unicode, cursor: ansi && eligible };
}
