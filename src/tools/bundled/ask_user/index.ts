import type { FormField, PanelDocument } from "../../../panels/contract.js";
import { validateDocument } from "../../../panels/validate.js";
import type { ToolContext } from "../../primitives.js";
import { errorResult } from "../../results.js";
import type { ToolHandlerResult } from "../../types.js";

type FreeText = Extract<FormField, { kind: "text" }>;
type Question = FormField & { free_text?: Omit<FreeText, "kind" | "required"> };
interface Input { questions: Question[]; title?: string; timeout_ms?: number }
function documentFor(args: Input): PanelDocument {
  const fields: FormField[] = [];
  for (const question of args.questions) {
    const { free_text, ...field } = question;
    fields.push({ ...field, required: field.required ?? true });
    if (free_text) {
      if (field.kind === "text") throw new Error("free_text is only supported on choice questions");
      fields.push({ ...free_text, kind: "text", required: false });
    }
  }
  return { ...(args.title !== undefined ? { title: args.title } : {}), blocks: [{ id: "form", kind: "form", fields }] };
}
export function validateArgs(raw: unknown): string | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
    if (Object.keys(raw).some(key => !["questions", "title", "timeout_ms"].includes(key))) return "unknown argument";
    const args = raw as Input;
    if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) return "questions must contain 1–3 entries";
    if (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 86400000)) return "timeout_ms must be positive and at most 24 hours";
    validateDocument(documentFor(args));
    return undefined;
  } catch (error) { return (error as Error).message; }
}
export async function handler(raw: unknown, context: ToolContext): Promise<ToolHandlerResult> {
  const invalid = validateArgs(raw);
  if (invalid) return errorResult("invalid_arguments", invalid);
  if (!context.interactions) return errorResult("interaction_unavailable", "This host has no response adapter");
  const args = raw as Input;
  try {
    const result = await context.interactions.request({ panel: "questions", document: documentFor(args),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}) });
    return { isError: result.status !== "answered", ...(result.status !== "answered" ? { code: `interaction_${result.status}` } : {}),
      content: [{ type: "json", value: result }] };
  } catch (error) {
    // Standalone plugins and the host have separate module instances; protocol error codes cross that boundary.
    const failure = error as Error & { code?: string };
    return errorResult(failure.code?.startsWith("interaction_") ? failure.code : "interaction_error", failure.message);
  }
}
