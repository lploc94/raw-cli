import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { renderUserInput, type ProviderAdapter, type ProviderProfile, type ProviderRequest, type ProviderTurn, type ModelToolCall } from "./types.js";
import { nativeToolContent } from "./content.js";
import { ProviderError, withProviderAbort } from "./client.js";
import { cacheSettings } from "./cache.js";

function inputMessages(request: ProviderRequest, provider: ProviderProfile["provider"]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: request.system }];
  const pendingImages: { mimeType: "image/png" | "image/jpeg"; data: string }[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    messages.push({ role: "user", content: pendingImages.splice(0).map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })) });
  };
  for (const message of request.messages) {
    if (message.role !== "tool") flushImages();
    if (message.role === "user") messages.push({ role: "user", content: renderUserInput(message.content) });
    else if (message.role === "assistant") {
      const opaque = (provider === "openrouter" || provider === "deepseek") && message.opaque && typeof message.opaque === "object" && !Array.isArray(message.opaque)
        ? message.opaque as Record<string, unknown> : {};
      messages.push({
        role: "assistant",
        content: message.text,
        ...opaque,
        ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments) },
        })) } : {}),
      } as ChatCompletionMessageParam);
    } else {
      const content = nativeToolContent(message.result);
      messages.push({ role: "tool", tool_call_id: message.callId, content: content.text || (content.images.length ? "[image attached]" : "") });
      pendingImages.push(...content.images);
    }
  }
  flushImages();
  return messages;
}

export function createOpenAiProvider(profile: Readonly<ProviderProfile>): ProviderAdapter {
  const fallbackCacheKey = randomUUID();
  const client = new OpenAI({
    apiKey: profile.apiKey ?? (profile.provider === "ollama" ? "ollama" : "unused"),
    ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
    maxRetries: 0,
  });
  return {
    profile,
    async generate(request): Promise<ProviderTurn> {
      return withProviderAbort(request, async (signal) => {
        const cache = cacheSettings(profile, request.cacheKey, fallbackCacheKey);
        const messages = inputMessages(request, profile.provider);
        const tools: ChatCompletionTool[] = request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as unknown as Record<string, unknown> },
        }));
        const configured = profile.request;
        const openAiOptions = configured?.kind === "openai" ? configured : undefined;
        const deepSeekOptions = configured?.kind === "deepseek" ? configured : undefined;
        const outputLimit = request.maxOutputTokens ?? configured?.maxOutputTokens ?? profile.maxOutputTokens;
        const stream = await client.chat.completions.create({
          model: profile.model,
          messages,
          stream: true,
          ...cache.openai,
          ...(cache.llamaPrompt ? { cache_prompt: true } : {}),
          ...(openAiOptions?.serviceTier ? { service_tier: openAiOptions.serviceTier } : {}),
          ...(openAiOptions?.reasoningEffort ? { reasoning_effort: openAiOptions.reasoningEffort } : {}),
          ...(deepSeekOptions?.thinking ? { thinking: { type: deepSeekOptions.thinking } } : {}),
          ...(deepSeekOptions?.reasoningEffort ? { reasoning_effort: deepSeekOptions.reasoningEffort } : {}),
          ...(profile.provider === "openai" ? { stream_options: { include_usage: true } } : {}),
          ...(tools.length ? { tools } : {}),
          ...(outputLimit !== undefined ? (profile.provider === "openai"
            ? { max_completion_tokens: outputLimit }
            : { max_tokens: outputLimit }) : {}),
        }, { signal, timeout: request.timeoutMs, maxRetries: 0 });
        let text = "";
        let finishReason: string | undefined;
        let usage: unknown;
        const reasoningDetails: unknown[] = [];
        let reasoningContent = "";
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        try {
        for await (const chunk of stream) {
          if (signal.aborted) throw new ProviderError("aborted", "provider stream aborted");
          if (chunk.usage) usage = chunk.usage;
          for (const choice of chunk.choices) {
            if (choice.index !== 0) throw new ProviderError("invalid_stream", "multiple OpenAI choices are unsupported");
            const delta = choice.delta;
            if (delta.refusal) throw new ProviderError("refusal", delta.refusal);
            if (profile.provider === "openrouter") {
              const details = (delta as unknown as { reasoning_details?: unknown[] }).reasoning_details;
              if (Array.isArray(details)) reasoningDetails.push(...details);
            }
            if (profile.provider === "deepseek") {
              const part = (delta as unknown as { reasoning_content?: unknown }).reasoning_content;
              if (typeof part === "string") { reasoningContent += part; request.onReasoningDelta?.(part); }
            }
            if (profile.provider !== "deepseek") {
              const part = (delta as unknown as { reasoning?: unknown }).reasoning;
              if (typeof part === "string") request.onReasoningDelta?.(part);
            }
            if (delta.content) { text += delta.content; request.onTextDelta?.(delta.content); }
            for (const part of delta.tool_calls ?? []) {
              if (part.index < 0 || !Number.isSafeInteger(part.index)) throw new ProviderError("invalid_stream", "invalid tool index");
              const current = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
              if (part.id) {
                if (current.id && current.id !== part.id) throw new ProviderError("invalid_stream", "tool ID changed during stream");
                current.id = part.id;
              }
              if (part.function?.name) current.name += part.function.name;
              if (part.function?.arguments) current.arguments += part.function.arguments;
              calls.set(part.index, current);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
        if (!finishReason) throw new ProviderError("incomplete_stream", "OpenAI stream ended without finish reason");
        if (finishReason !== "stop" && finishReason !== "tool_calls") throw new ProviderError("provider_finish", `OpenAI finish reason: ${finishReason}`);
        const toolCalls: ModelToolCall[] = [];
        const suppliedIds = new Set<string>();
        for (const call of calls.values()) {
          if (!call.id) continue;
          if (suppliedIds.has(call.id)) throw new ProviderError("invalid_stream", "duplicate tool call ID");
          suppliedIds.add(call.id);
        }
        const usedIds = new Set(suppliedIds);
        for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
          if (!call.name) throw new ProviderError("invalid_stream", "tool name missing");
          let id = call.id;
          let syntheticId = false;
          if (!id) {
            syntheticId = true;
            id = `raw-tool-${index}`;
            while (usedIds.has(id)) id += "-";
            usedIds.add(id);
          }
          let args: unknown;
          let argumentError: string | undefined;
          try { args = JSON.parse(call.arguments); }
          catch { argumentError = `tool ${call.name} arguments are invalid JSON`; }
          if (!argumentError && (!args || typeof args !== "object" || Array.isArray(args))) argumentError = `tool ${call.name} arguments must be an object`;
          toolCalls.push({ id, name: call.name, arguments: argumentError ? {} : args as Record<string, unknown>,
            ...(argumentError ? { argumentError, rawArguments: call.arguments } : {}), ...(syntheticId ? { syntheticId } : {}) });
        }
        if (finishReason === "tool_calls" && !toolCalls.length) throw new ProviderError("invalid_stream", "tool finish without calls");
        if (finishReason === "stop" && toolCalls.length) throw new ProviderError("invalid_stream", "calls without tool finish");
        return { text, toolCalls, finishReason,
          ...(reasoningDetails.length ? { opaque: { reasoning_details: reasoningDetails } } : {}),
          ...(reasoningContent ? { opaque: { reasoning_content: reasoningContent } } : {}),
          ...(usage !== undefined ? { usage } : {}) };
        } finally {
          if (!signal.aborted && usage !== undefined) request.onUsage?.(usage);
        }
      });
    },
  };
}
