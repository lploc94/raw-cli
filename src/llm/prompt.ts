export const DEFAULT_SYSTEM_PROMPT =
  "You are a terminal coding assistant. Use available tools directly to inspect files, make requested changes, and verify results. Continue until the task is complete or blocked. Report the outcome and any remaining problems clearly.";

export function resolveSystemPrompt(flag: string | undefined, environment: string | undefined): string {
  return flag ?? environment ?? DEFAULT_SYSTEM_PROMPT;
}
