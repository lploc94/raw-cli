import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testConfig(provider: string, modelId = "fixture", baseUrl?: string, apiKeyEnv?: string, vision = false): string {
  const directory = mkdtempSync(join(tmpdir(), "raw-model-config-"));
  const path = join(directory, "config.json");
  const method = provider === "anthropic" ? "anthropic-messages"
    : provider === "google" ? "google-generate-content" : "openai-chat-completions";
  writeFileSync(path, JSON.stringify({
    default_profile: "fixture",
    models: { fixture: { provider, method, model_id: modelId, ...(vision ? { vision } : {}),
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      ...(apiKeyEnv === undefined ? {} : { api_key_env: apiKeyEnv }) } },
    profiles: { fixture: { model: "fixture" } },
  }));
  return path;
}
