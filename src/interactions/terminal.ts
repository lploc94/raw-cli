import { randomUUID } from "node:crypto";
import type { FormAnswers } from "../panels/contract.js";
import { MAX_TEXT_ANSWER_BYTES, validateFormAnswers } from "../panels/forms.js";
import { safeTerminalText } from "../terminal/safe.js";
import type { InteractionAdapter } from "./contract.js";

interface Lines { mark(): number; nextAfter(mark: number, signal?: AbortSignal): Promise<string | undefined> }
/** Shares the CLI's input queue; the enclosing agent run pauses the chat reader. */
export function terminalInteractionAdapter(lines: Lines, write: (text: string) => void): InteractionAdapter {
  return async (request, signal) => {
    const scope = { requestId: request.identity.requestId, expectedRevision: request.revision, idempotencyKey: randomUUID() };
    const cancel = () => ({ ...scope, response: "cancel" as const });
    const mark = lines.mark();
    const print = (text: string) => write(`${safeTerminalText(text)}\n`);
    print(request.document.title ?? "Questions");
    print("Enter /cancel to cancel. Blank skips an optional field.");
    for (;;) {
      const answers: FormAnswers = Object.create(null) as FormAnswers;
      for (const field of request.form.fields) {
        for (;;) {
          if (signal.aborted) return cancel();
          print(`${field.label}${field.required ? " (required)" : " (optional)"}`);
          if (field.description) print(field.description);
          if (field.kind === "text") print(`Maximum ${field.max_bytes} UTF-8 bytes${field.multiline ? '; finish multiline text with a line containing .' : ''}`);
          else {
            field.options.forEach((option, index) => print(`${index + 1}. ${option.label} [id:${option.id}]`));
            print(field.kind === "multi_select" ? "Enter comma-separated numbers or id:values." : "Enter a number or id:value.");
          }
          let value: string | string[] | undefined;
          const first = await lines.nextAfter(mark, signal);
          if (first === undefined || first === "/cancel" || signal.aborted) return cancel();
          if (field.kind === "text") {
            const limit = field.max_bytes ?? MAX_TEXT_ANSWER_BYTES;
            let retained = first === "." && field.multiline ? 0 : Buffer.byteLength(first);
            let oversized = retained > limit;
            const parts = oversized || (first === "." && field.multiline) ? [] : [first];
            if (field.multiline && first !== "." && (first !== "" || field.required)) {
              for (;;) {
                const line = await lines.nextAfter(mark, signal);
                if (line === undefined || line === "/cancel" || signal.aborted) return cancel();
                if (line === ".") break;
                if (!oversized) {
                  retained += Buffer.byteLength(line) + (parts.length ? 1 : 0);
                  oversized = retained > limit;
                  if (!oversized) parts.push(line);
                }
              }
            }
            if (oversized) { print(`${field.id} exceeds its effective byte limit`); continue; }
            value = parts.join("\n");
          } else if (first.trim()) {
            const optionId = (input: string) => {
              const token = input.trim();
              return token.startsWith("id:") ? token.slice(3) : /^\d+$/.test(token) ? field.options[Number(token) - 1]?.id ?? token : token;
            };
            value = field.kind === "multi_select" ? first.split(",").map(optionId) : optionId(first);
          }
          if (!field.required && (value === "" || value === undefined)) value = undefined;
          try {
            const normalized = validateFormAnswers({ fields: [field], maxResultBytes: request.form.maxResultBytes }, value === undefined ? {} : { [field.id]: value });
            if (Object.hasOwn(normalized, field.id)) answers[field.id] = normalized[field.id]!;
            break;
          } catch (error) { print(error instanceof Error ? error.message : "Invalid answer"); }
        }
      }
      try { return { ...scope, response: "submit", answers: validateFormAnswers(request.form, answers) }; }
      catch (error) { print(error instanceof Error ? error.message : "Invalid answer"); print("Please enter the answers again within the combined result budget."); }
    }
  };
}
