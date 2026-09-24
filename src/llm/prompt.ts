export const DEFAULT_SYSTEM_PROMPT =
  "You are a terminal coding assistant. Use read_file, write_file, and bash to complete tasks. Respond concisely.";

export function resolveSystemPrompt(flag: string | undefined, environment: string | undefined): string {
  return flag ?? environment ?? DEFAULT_SYSTEM_PROMPT;
}
