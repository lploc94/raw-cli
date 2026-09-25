import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import { renderUserInput, type ProviderAdapter, type ResolvedModelConfig, type ProviderRequest, type ProviderTurn, type ModelToolCall } from "./types.js";
import { nativeToolContent } from "./content.js";
import { ProviderError, withProviderAbort } from "./client.js";
import { cacheSettings } from "./cache.js";

function inputContents(request: ProviderRequest): Content[] {
  const contents: Content[] = [];
  const syntheticIds = new Set<string>();
  const pendingResults: Part[] = [];
  const flushResults = () => {
    if (pendingResults.length) contents.push({ role: "user", parts: pendingResults.splice(0) });
  };
  for (const message of request.messages) {
    if (message.role !== "tool") flushResults();
    if (message.role === "user") contents.push({ role: "user", parts: [{ text: renderUserInput(message.content) }] });
    else if (message.role === "assistant") {
      syntheticIds.clear();
      for (const call of message.toolCalls) if (call.syntheticId) syntheticIds.add(call.id);
      const parts: Part[] = Array.isArray(message.opaque) ? message.opaque as Part[] : [
        ...(message.text ? [{ text: message.text }] : []),
        ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.arguments, ...(!call.syntheticId ? { id: call.id } : {}) } })),
      ];
      contents.push({ role: "model", parts });
    } else {
      const result = nativeToolContent(message.result);
      pendingResults.push({ functionResponse: {
        name: message.name,
        ...(!syntheticIds.has(message.callId) ? { id: message.callId } : {}),
        response: message.result.isError ? { error: result.text } : { output: result.text },
        ...(result.images.length ? { parts: result.images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })) } : {}),
      } });
    }
  }
  flushResults();
  return contents;
}

export function createGoogleProvider(modelConfig: Readonly<ResolvedModelConfig>): ProviderAdapter {
  const client = new GoogleGenAI({
    apiKey: modelConfig.apiKey ?? "",
    httpOptions: { ...(modelConfig.baseUrl ? { baseUrl: modelConfig.baseUrl } : {}), retryOptions: { attempts: 1 } },
  });
  return {
    modelConfig,
    async generate(request): Promise<ProviderTurn> {
      return withProviderAbort(request, async (signal) => {
        cacheSettings(modelConfig, request.cacheKey);
        const configured = modelConfig.request?.kind === "google" ? modelConfig.request : undefined;
        const stream = await client.models.generateContentStream({
          model: modelConfig.model,
          contents: inputContents(request),
          config: {
            systemInstruction: request.system,
            abortSignal: signal,
            httpOptions: { timeout: request.timeoutMs, retryOptions: { attempts: 1 } },
            ...(request.maxOutputTokens ?? modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens
              ? { maxOutputTokens: request.maxOutputTokens ?? modelConfig.request?.maxOutputTokens ?? modelConfig.maxOutputTokens } : {}),
            ...(configured?.thinkingLevel ? { thinkingConfig: { thinkingLevel: {
              minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH,
            }[configured.thinkingLevel] } } : {}),
            ...(configured?.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: configured.thinkingBudget } } : {}),
            ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map((tool) => ({
              name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema,
            })) }] } : {}),
          },
        });
        let text = "";
        let finishReason: string | undefined;
        let usage: unknown;
        const parts: Part[] = [];
        const rawCalls: { id?: string; name: string; arguments: Record<string, unknown> }[] = [];
        try {
        for await (const chunk of stream) {
          if (signal.aborted) throw new ProviderError("aborted", "provider stream aborted");
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          if (chunk.promptFeedback?.blockReason) throw new ProviderError("refusal", `Google prompt blocked: ${chunk.promptFeedback.blockReason}`);
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          if (candidate.finishReason) finishReason = candidate.finishReason;
          for (const part of candidate.content?.parts ?? []) {
            parts.push(part);
            if (part.thought) { if (part.text) request.onReasoningDelta?.(part.text); continue; }
            if (part.text) { text += part.text; request.onTextDelta?.(part.text); }
            if (part.functionCall) {
              const call = part.functionCall;
              const args = call.args === undefined ? {} : call.args;
              if (!call.name || !args || typeof args !== "object" || Array.isArray(args) || call.id === "") throw new ProviderError("invalid_stream", "Google function call invalid");
              rawCalls.push({ ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, arguments: args });
            }
          }
        }
        if (!finishReason) throw new ProviderError("incomplete_stream", "Google stream ended without finish reason");
        if (finishReason !== "STOP") throw new ProviderError("provider_finish", `Google finish reason: ${finishReason}`);
        const suppliedIds = new Set<string>();
        for (const call of rawCalls) {
          if (!call.id) continue;
          if (suppliedIds.has(call.id)) throw new ProviderError("invalid_stream", "duplicate Google function call ID");
          suppliedIds.add(call.id);
        }
        const usedIds = new Set(suppliedIds);
        const toolCalls: ModelToolCall[] = rawCalls.map((call, index) => {
          if (call.id) return { id: call.id, name: call.name, arguments: call.arguments };
          let id = `raw-google-${index}`;
          while (usedIds.has(id)) id += "-";
          usedIds.add(id);
          return { id, name: call.name, arguments: call.arguments, syntheticId: true };
        });
        return { text, toolCalls, finishReason, opaque: parts, ...(usage !== undefined ? { usage } : {}) };
        } finally {
          if (!signal.aborted && usage !== undefined) request.onUsage?.(usage);
        }
      });
    },
  };
}
