import { CHECKPOINT_NO_TOOLS_GUARD, COMPACT_SYSTEM_PROMPT } from "../../src/compact.js";
import type { ModelMessage } from "../../src/llm/types.js";

type Request = { system: string; messages: readonly ModelMessage[] };
const text = (message: ModelMessage | undefined) => message?.role === "user" && typeof message.content === "string" ? message.content : undefined;

/** A checkpoint request: the chunked shape (its own system prompt) or the same-context shape (the prompt appended last). */
export function isCompactionRequest(request: Request): boolean {
  return request.system === COMPACT_SYSTEM_PROMPT || text(request.messages.at(-1))?.startsWith(CHECKPOINT_NO_TOOLS_GUARD) === true;
}

/** The text of a checkpoint request that carries the prompt: the transcript and prompt, or the appended prompt. */
export function compactionInput(request: Request): string {
  return (request.system === COMPACT_SYSTEM_PROMPT ? text(request.messages[0]) : text(request.messages.at(-1))) ?? "";
}
