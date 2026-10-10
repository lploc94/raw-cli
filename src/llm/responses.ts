import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses";
import { renderUserInput, truncatedArgumentsError, type ModelToolCall, type ProviderAdapter, type ResolvedModelConfig, type ProviderRequest, type ProviderTurn } from "./types.js";
import { nativeToolContent, nativeUserContent } from "./content.js";
import { ProviderError, withProviderAbort } from "./client.js";
import { cacheSettings } from "./cache.js";

function inputItems(request: ProviderRequest): ResponseInput {
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      const parts = nativeUserContent(message.content);
      input.push({ role: "user", content: parts.some((part) => part.type === "image")
        ? parts.flatMap((part): Array<Record<string, unknown>> => part.type === "image"
          ? [{ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` }]
          : part.text ? [{ type: "input_text", text: part.text }] : [])
        : renderUserInput(message.content) });
    }
    else if (message.role === "assistant") {
      if (Array.isArray(message.opaque)) input.push(...structuredClone(message.opaque));
      else {
        if (message.text) input.push({ role: "assistant", content: message.text });
        for (const call of message.toolCalls) input.push({ type: "function_call", call_id: call.id, name: call.name,
          arguments: call.rawArguments ?? JSON.stringify(call.arguments) });
      }
    } else {
      const result = nativeToolContent(message.result);
      const output = result.images.length ? [
        ...(result.text ? [{ type: "input_text", text: result.text }] : []),
        ...result.images.map((image) => ({ type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` })),
      ] : result.text;
      input.push({ type: "function_call_output", call_id: message.callId, output });
    }
  }
  return input as ResponseInput;
}

function completedTurn(output: readonly ResponseOutputItem[], usage: unknown, truncated = false): ProviderTurn {
  let text = "";
  const calls: ModelToolCall[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
        else if (part.type === "refusal") throw new ProviderError("refusal", part.refusal);
      }
    } else if (item.type === "function_call") {
      if (!item.call_id || seen.has(item.call_id)) throw new ProviderError("invalid_stream", "missing or duplicate Responses call ID");
      seen.add(item.call_id);
      let args: unknown;
      let argumentError: string | undefined;
      try { args = JSON.parse(item.arguments); }
      catch { argumentError = truncated ? truncatedArgumentsError(item.name) : `tool ${item.name} arguments are invalid JSON`; }
      if (!argumentError && (!args || typeof args !== "object" || Array.isArray(args))) argumentError = `tool ${item.name} arguments must be an object`;
      calls.push({ id: item.call_id, name: item.name, arguments: argumentError ? {} : args as Record<string, unknown>,
        ...(argumentError ? { argumentError, rawArguments: item.arguments } : {}) });
    } else if (item.type !== "reasoning") {
      throw new ProviderError("unsupported_output", `unsupported Responses output item: ${item.type}`);
    }
  }
  // Incomplete output items cannot be replayed as-is, so a truncated turn travels as its text and calls instead.
  return { text, toolCalls: calls, finishReason: truncated ? "max_output_tokens" : calls.length ? "tool_calls" : "stop",
    ...(truncated ? { truncated } : { opaque: structuredClone(output) }), ...(usage !== undefined ? { usage } : {}) };
}

export function createResponsesProvider(modelConfig: Readonly<ResolvedModelConfig>): ProviderAdapter {
  const fallbackCacheKey = randomUUID();
  const client = new OpenAI({ apiKey: modelConfig.apiKey ?? "unused", ...(modelConfig.baseUrl ? { baseURL: modelConfig.baseUrl } : {}), maxRetries: 0 });
  return { modelConfig, async generate(request): Promise<ProviderTurn> {
    return withProviderAbort(request, async (signal, touch) => {
      const cache = cacheSettings(modelConfig, request.cacheKey, fallbackCacheKey);
      const options = modelConfig.request?.kind === "openai" ? modelConfig.request : undefined;
      const stream = await client.responses.create({
        model: modelConfig.model,
        instructions: request.system,
        input: inputItems(request),
        store: false,
        stream: true,
        ...cache.openai,
        ...(options?.serviceTier ? { service_tier: options.serviceTier } : {}),
        ...(options?.reasoningEffort || options?.reasoningMode ? { reasoning: {
          ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
          ...(options.reasoningMode ? { mode: options.reasoningMode } : {}),
        } } : {}),
        ...(request.maxOutputTokens ?? modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens
          ? { max_output_tokens: request.maxOutputTokens ?? modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens } : {}),
        ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function" as const, name: tool.name,
          description: tool.description, parameters: tool.inputSchema as Record<string, unknown>, strict: false })) } : {}),
      }, { signal, timeout: request.timeoutMs, maxRetries: 0 });
      let completed: ResponseOutputItem[] | undefined;
      let usage: unknown;
      try {
        for await (const event of stream) {
          touch();
          if (signal.aborted) throw new ProviderError("aborted", "Responses stream aborted");
          if (event.type === "response.output_text.delta") request.onTextDelta?.(event.delta);
          else if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
            request.onReasoningDelta?.(event.delta);
          }
          else if (event.type === "response.completed") {
            if (completed) throw new ProviderError("invalid_stream", "duplicate Responses completion");
            completed = event.response.output;
            usage = event.response.usage;
          } else if (event.type === "response.failed") {
            usage = event.response.usage;
            throw new ProviderError("provider_finish", "Responses request failed");
          } else if (event.type === "response.incomplete") {
            usage = event.response.usage;
            const reason = event.response.incomplete_details?.reason;
            if (reason !== "max_output_tokens") throw new ProviderError("provider_finish", `Responses request incomplete${reason ? `: ${reason}` : ""}`);
            if (completed) throw new ProviderError("invalid_stream", "duplicate Responses completion");
            return completedTurn(event.response.output, usage, true);
          }
          else if (event.type === "error") throw new ProviderError("provider_error", event.message);
        }
        if (!completed) throw new ProviderError("incomplete_stream", "Responses stream ended without completion");
        return completedTurn(completed, usage);
      } finally {
        if (!signal.aborted && usage !== undefined) request.onUsage?.(usage);
      }
    });
  } };
}
