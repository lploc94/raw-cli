import type { FormAnswers, FormField, InteractionState } from "./contract.js";

export type InteractionResult = { status: "answered"; answers: FormAnswers } | { status: Exclude<InteractionState, "pending" | "answered"> };
export interface PreparedForm { fields: FormField[]; maxResultBytes: number }
export class FormValidationError extends Error {
  constructor(readonly code: "interaction_invalid" | "interaction_budget_too_small" | "interaction_budget_exceeded", message: string) {
    super(`${code}: ${message}`); this.name = "FormValidationError";
  }
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
export const canonicalInteractionResult = (result: InteractionResult): string => JSON.stringify(result);
const encodedSize = (answers: FormAnswers) => bytes(canonicalInteractionResult({ status: "answered", answers }));
const fail = (message: string): never => { throw new FormValidationError("interaction_invalid", message); };
const minimumCount = (field: Extract<FormField, { kind: "multi_select" }>) => Math.max(field.min_selected ?? 0, field.required ? 1 : 0);

/** Smallest representable response; IDs and JSON envelope count, not display labels. */
function minimumAnswers(fields: readonly FormField[]): FormAnswers {
  const answers: FormAnswers = Object.create(null) as FormAnswers;
  for (const field of fields) {
    if (!field.required) continue;
    if (field.kind === "text") answers[field.id] = "x";
    else {
      const options = [...field.options].sort((a, b) => bytes(JSON.stringify(a.id)) - bytes(JSON.stringify(b.id)));
      answers[field.id] = field.kind === "single_select" ? options[0]!.id : options.slice(0, minimumCount(field)).map(option => option.id);
    }
  }
  return { ...answers };
}

/** Portable host/browser oracle. The aggregate encoded limit remains authoritative. */
export function prepareForm(fields: readonly FormField[], outputBudget: number): PreparedForm {
  const maxResultBytes = Math.min(16384, Math.max(0, Math.floor(outputBudget)));
  const minimum = minimumAnswers(fields);
  if (!Number.isFinite(maxResultBytes) || encodedSize(minimum) > maxResultBytes)
    throw new FormValidationError("interaction_budget_too_small", "the minimum answer and result envelope cannot fit");
  const effective = fields.map(field => {
    if (field.kind === "text") {
      const other = { ...minimum, [field.id]: "" };
      // Six bytes per input byte covers the worst JSON escaping of ASCII control characters.
      const available = Math.floor((maxResultBytes - encodedSize(other)) / 6);
      return { ...field, max_bytes: Math.min(field.max_bytes ?? 8192, 8192, Math.max(1, available)) };
    }
    if (field.kind === "multi_select") {
      const shortest = [...field.options].sort((a, b) => bytes(JSON.stringify(a.id)) - bytes(JSON.stringify(b.id)));
      let maximum = Math.min(field.max_selected ?? field.options.length, field.options.length);
      while (maximum > minimumCount(field) && encodedSize({ ...minimum, [field.id]: shortest.slice(0, maximum).map(option => option.id) }) > maxResultBytes) maximum--;
      return { ...field, max_selected: maximum };
    }
    return structuredClone(field);
  });
  return { fields: effective, maxResultBytes };
}

export function validateFormAnswers(form: PreparedForm, input: unknown): FormAnswers {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("answers must be an object");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!form.fields.some(field => field.id === key)) fail(`unknown field ${key}`);
  const answers: FormAnswers = Object.create(null) as FormAnswers;
  for (const field of form.fields) {
    const value = Object.hasOwn(raw, field.id) ? raw[field.id] : undefined;
    if (value === undefined) { if (field.required) fail(`${field.id} is required`); continue; }
    if (field.kind === "text") {
      if (typeof value !== "string") fail(`${field.id} must be text`);
      const text = value as string;
      if (field.required && !text.trim()) fail(`${field.id} is required`);
      if (bytes(text) > (field.max_bytes ?? 8192)) fail(`${field.id} exceeds its effective byte limit`);
      answers[field.id] = text;
    } else if (field.kind === "single_select") {
      if (typeof value !== "string" || !field.options.some(option => option.id === value)) fail(`${field.id} has an unknown option`);
      answers[field.id] = value as string;
    } else {
      if (!Array.isArray(value) || value.some(option => typeof option !== "string")) fail(`${field.id} must be an array of option IDs`);
      const selections = value as string[];
      if (new Set(selections).size !== selections.length) fail(`${field.id} repeats an option`);
      if (selections.some(id => !field.options.some(option => option.id === id))) fail(`${field.id} has an unknown option`);
      if (selections.length < minimumCount(field) || selections.length > (field.max_selected ?? field.options.length)) fail(`${field.id} has an invalid selection count`);
      answers[field.id] = field.options.filter(option => selections.includes(option.id)).map(option => option.id);
    }
  }
  if (encodedSize(answers) > form.maxResultBytes) throw new FormValidationError("interaction_budget_exceeded", "the complete encoded answer exceeds the result budget");
  return { ...answers };
}
