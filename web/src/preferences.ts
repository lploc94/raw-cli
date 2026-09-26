import { useEffect, useState } from "react";

export interface Preferences {
  version: 1;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  chatSize: number;
  codeSize: number;
  contextWidth: number;
  inspectorWidth: number;
  sendMode: "enter" | "modifier";
  reasoning: boolean;
  toolDetails: boolean;
  follow: boolean;
}
export const defaultPreferences: Preferences = {
  version: 1,
  theme: "system",
  density: "comfortable",
  chatSize: 16,
  codeSize: 14,
  contextWidth: 260,
  inspectorWidth: 320,
  sendMode: "enter",
  reasoning: false,
  toolDetails: false,
  follow: true,
};
const key = "raw.dashboard.preferences.v1";
export function loadPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!p || p.version !== 1) return { ...defaultPreferences };
    const numeric = (
      name: "chatSize" | "codeSize" | "contextWidth" | "inspectorWidth",
      min: number,
      max: number,
    ) =>
      typeof p[name] === "number" &&
      Number.isFinite(p[name]) &&
      p[name] >= min &&
      p[name] <= max
        ? p[name]
        : defaultPreferences[name];
    return {
      version: 1,
      theme: ["system", "light", "dark"].includes(p.theme) ? p.theme : "system",
      density: p.density === "compact" ? "compact" : "comfortable",
      sendMode: p.sendMode === "modifier" ? "modifier" : "enter",
      chatSize: numeric("chatSize", 14, 22),
      codeSize: numeric("codeSize", 12, 20),
      contextWidth: numeric("contextWidth", 240, 320),
      inspectorWidth: numeric("inspectorWidth", 300, 360),
      reasoning: typeof p.reasoning === "boolean" ? p.reasoning : false,
      toolDetails: typeof p.toolDetails === "boolean" ? p.toolDetails : false,
      follow: typeof p.follow === "boolean" ? p.follow : true,
    };
  } catch {
    return { ...defaultPreferences };
  }
}
export function usePreferences() {
  const [preferences, setPreferences] = useState(loadPreferences);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {}
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const root = document.documentElement;
      root.dataset.theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme;
      root.dataset.density = preferences.density;
      for (const [name, value] of Object.entries({
        "chat-size": preferences.chatSize,
        "code-size": preferences.codeSize,
        "context-width": preferences.contextWidth,
        "inspector-width": preferences.inspectorWidth,
      }))
        root.style.setProperty(`--${name}`, `${value}px`);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);
  return [preferences, setPreferences] as const;
}
