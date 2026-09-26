export function createStarterConfig(): Record<string, unknown> {
  return {
    default_agent: "raw",
    vars: { now: { description: "Current UTC time", access: "read", source: { kind: "provider", name: "system.time" } } },
    models: {
      local: {
        provider: "ollama",
        method: "openai-chat-completions",
        model_id: "YOUR_INSTALLED_MODEL",
        base_url: "http://127.0.0.1:11434/v1",
      },
    },
    agents: { raw: {
      model: "local",
      vars: ["now"],
      system_prompt: "You are Raw, a terminal coding assistant. Use available tools to inspect files, make requested changes, and verify results. Continue until the task is complete or blocked. For requests about configuring or extending Raw, call list_skills to inspect selected guidance, then load_skill only for relevant skills. If none applies, continue with the available tools. For unrelated tasks, work normally without loading setup instructions. For current external values, call list_vars, then read_var when relevant; previous readings are historical. Report the outcome and remaining problems clearly.",
      tools: { use: ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill", "builtin/list_vars", "builtin/read_var"] },
      skills: { use: ["builtin/configure_raw", "builtin/create_skill", "builtin/create_tool", "builtin/create_agent", "builtin/add_mcp", "builtin/create_package"] },
    } },
  };
}
