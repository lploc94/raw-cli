import type { ModelRequestOptions } from "./types.js";

/** Output cap assumed when neither the agent request nor the model declares one: sized for current models' long answers. */
export const DEFAULT_OUTPUT_TOKENS = 32000;

/**
 * The output budget a request reserves: the configured cap, else the default bounded to an eighth of a declared
 * context so small local models keep room for input.
 */
export function effectiveOutputTokens(model: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined;
  request?: Readonly<ModelRequestOptions> | undefined }): number {
  return model.request?.maxOutputTokens ?? model.maxOutputTokens
    ?? (model.contextWindow !== undefined ? Math.max(1, Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(model.contextWindow / 8))) : DEFAULT_OUTPUT_TOKENS);
}
