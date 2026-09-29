// The per-turn request choice: which reasoning level / service tier the user picked for this session. Descriptors come from the server; nothing here knows a provider.
export interface ControlOption {
  value: string;
  label: string;
  hint?: string;
}
export interface RequestControlMeta {
  id: string;
  label: string;
  kind: "level" | "choice";
  options: ControlOption[];
  current?: string;
}
/** Control id → chosen option value. An absent id means "Agent default". */
export type RequestChoice = Record<string, string>;
export interface RequestBody {
  effort?: string;
  serviceTier?: string;
}

/** The ids a turn can carry; descriptors with other ids are ignored rather than rendered as controls that could not be sent. */
const SENDABLE = ["effort", "serviceTier"] as const;
export const usableControls = (controls: readonly RequestControlMeta[]) =>
  controls.filter((control) => (SENDABLE as readonly string[]).includes(control.id) && control.options.length > 0);

export const choiceKey = (session: string) => `raw.dashboard.request.${session}`;

export function readChoice(session: string): RequestChoice {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(choiceKey(session)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as RequestChoice;
  } catch {
    return {};
  }
}

export function writeChoice(session: string, choice: RequestChoice) {
  try {
    if (Object.keys(choice).length) sessionStorage.setItem(choiceKey(session), JSON.stringify(choice));
    else sessionStorage.removeItem(choiceKey(session));
  } catch {}
}

/** Drops values the loaded controls no longer offer (after an agent switch). */
export function pruneChoice(choice: RequestChoice, controls: readonly RequestControlMeta[]): RequestChoice {
  const kept: RequestChoice = {};
  for (const control of usableControls(controls)) {
    const value = choice[control.id];
    if (value !== undefined && control.options.some((option) => option.value === value)) kept[control.id] = value;
  }
  return kept;
}

/** The request body fragment; undefined when everything is Agent default, so the turn body is unchanged. */
export function requestBody(choice: RequestChoice, controls: readonly RequestControlMeta[]): RequestBody | undefined {
  const kept = pruneChoice(choice, controls);
  const body: RequestBody = {};
  if (kept.effort !== undefined) body.effort = kept.effort;
  if (kept.serviceTier !== undefined) body.serviceTier = kept.serviceTier;
  return Object.keys(body).length ? body : undefined;
}

/** `Label` for default, `Label: level` for a level, plus ` · tier` for a non-default tier (also when only the tier is set). */
export function pillText(controls: readonly RequestControlMeta[], choice: RequestChoice): { label: string; level: string; tier: string } {
  const usable = usableControls(controls);
  const primary = usable.find((control) => control.id === "effort") ?? usable[0];
  if (!primary) return { label: "", level: "", tier: "" };
  const kept = pruneChoice(choice, controls);
  return { label: primary.label, level: kept[primary.id] ?? "", tier: primary.id === "effort" ? (kept.serviceTier ?? "") : "" };
}

/** One sentence for assistive tech: every control with its current value. */
export function pillDescription(controls: readonly RequestControlMeta[], choice: RequestChoice): string {
  const kept = pruneChoice(choice, controls);
  return usableControls(controls)
    .map((control) => `${control.label} ${kept[control.id] ?? "Agent default"}`)
    .join(", ");
}
