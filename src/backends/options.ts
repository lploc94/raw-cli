import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RequestControl } from "../request-controls.js";
import type { BackendOptions } from "./acp-agent.js";
import type { AgyModel } from "./agy.js";

/** One value a backend offers for model, effort or mode, as the dashboard shows it. */
export interface BackendChoice { value: string; label: string; hint?: string }
/** What a backend offers for one option, and the value it runs with now. */
export interface BackendOffer { current?: string; options: BackendChoice[] }
/**
 * What a backend offers for each option, for display only: the runner checks a chosen value against the CLI's own list
 * at turn time (Fixed decision 6).
 */
export type BackendOffered = Partial<Record<keyof BackendOptions, BackendOffer>>;

/** The ACP `configOptions` category behind each option. */
const CATEGORIES = [["model", "model"], ["effort", "thought_level"], ["mode", "mode"]] as const;
const CONTROLS = { model: ["backend_model", "Model"], effort: ["backend_effort", "Effort"], mode: ["backend_mode", "Mode"] } as const;
/** agy 1.4.10's `--mode` values, and Raw's `skip-permissions` (docs/backends.md). */
export const AGY_MODES = ["accept-edits", "auto", "plan", "skip-permissions"] as const;

/**
 * The options an ACP session reports (`configOptions`), grouped choices flattened; `current` replaces the values the CLI
 * reports as in use (a conversation's baseline while a turn's override is applied).
 */
export function offeredFromConfigOptions(options: readonly SessionConfigOption[], current?: BackendOptions): BackendOffered {
  const offered: BackendOffered = {};
  for (const [key, category] of CATEGORIES) {
    const option = options.find((item) => item.category === category && item.type === "select");
    if (!option || option.type !== "select") continue;
    const choices = option.options.flatMap((item) => "group" in item ? item.options : [item]).map((item): BackendChoice => ({
      value: item.value, label: item.name || item.value, ...(item.description ? { hint: item.description } : {}) }));
    if (!choices.length) continue;
    const value = current ? current[key] : typeof option.currentValue === "string" ? option.currentValue : undefined;
    offered[key] = { ...(value ? { current: value } : {}), options: choices };
  }
  return offered;
}

/**
 * What agy offers: its model families, the efforts of the model in use (`model`, else the current one, else agy's default
 * by its display name), and its modes.
 */
export function offeredFromAgyCatalog(catalog: readonly AgyModel[] | undefined, current: BackendOptions, defaultName?: string,
  model = current.model): BackendOffered {
  const mode: BackendOffer = { ...(current.mode ? { current: current.mode } : {}), options: AGY_MODES.map((value) => ({ value, label: value })) };
  if (!catalog?.length) return { mode };
  const family = catalog.find((item) => item.slug === model || item.variants.some((variant) => variant.slug === model))
    ?? (model ? undefined : catalog.find((item) => item.name === defaultName || item.variants.some((variant) => variant.name === defaultName)));
  const offered: BackendOffered = {
    model: { ...(current.model ? { current: current.model } : {}), options: catalog.map((item) => ({ value: item.slug, label: item.name })) }, mode };
  if (family?.efforts.length) offered.effort = { ...(current.effort ? { current: current.effort } : {}), options: family.efforts.map((value) => ({ value, label: value })) };
  return offered;
}

/** The composer's controls for what a backend offers: one select per option. */
export function backendControls(offered: BackendOffered | undefined): RequestControl[] {
  if (!offered) return [];
  return (["model", "effort", "mode"] as const).flatMap((key) => {
    const offer = offered[key];
    if (!offer?.options.length) return [];
    const [id, label] = CONTROLS[key];
    return [{ id, label, kind: "select" as const, options: offer.options.map((choice) => ({ ...choice })),
      ...(offer.current ? { current: offer.current } : {}) }];
  });
}
