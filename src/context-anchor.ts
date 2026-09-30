/**
 * The provider-reported size of the conversation at its last response: `tokens` is that request's input plus the reply's output
 * tokens, `base` the byte estimate of the same request plus reply, `messageCount` how many model messages it covered and
 * `signature` identifies the system prompt, tool schemas and model it was measured with.
 */
export interface ContextAnchor { tokens: number; base: number; messageCount: number; signature: string }

/** A stored anchor that is malformed, or covers more messages than exist, is ignored: the estimate takes over. */
export function parseAnchor(value: unknown, messageCount: number): ContextAnchor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { tokens, base, messageCount: covered, signature } = value as Record<string, unknown>;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) return undefined;
  if (typeof covered !== "number" || !Number.isSafeInteger(covered) || covered < 0 || covered > messageCount) return undefined;
  if (typeof signature !== "string" || !signature) return undefined;
  return { tokens, base, messageCount: covered, signature };
}

/**
 * The size of a request built from the anchored context plus whatever was added since: the reported tokens plus the byte estimate
 * of only the addition, scaled by `scale` (the calibration the provider's own counts have demanded) and rounded up, so a large new
 * tool result is never undercounted. Unusable (undefined) when the anchor was measured with
 * another prompt/tools/model, covers more messages than now exist, or the request is smaller than the anchored one.
 */
export function anchoredEstimate(anchor: ContextAnchor | undefined, signature: string, messageCount: number, rawEstimate: number, scale = 1):
  { tokens: number; exact: boolean } | undefined {
  if (!anchor || anchor.signature !== signature || anchor.messageCount > messageCount || rawEstimate < anchor.base) return undefined;
  return { tokens: anchor.tokens + Math.ceil((rawEstimate - anchor.base) * scale), exact: rawEstimate === anchor.base };
}
