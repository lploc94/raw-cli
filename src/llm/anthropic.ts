import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { effectiveOutputTokens } from "./output.js";
import { isNativeCompaction, renderUserInput, truncatedArgumentsError, type ModelMessage, type NativeCompactRequest, type ProviderAdapter,
  type ResolvedModelConfig, type ProviderRequest, type ProviderTurn, type ModelToolCall, type ReplayedBlock } from "./types.js";
import { nativeToolContent, nativeUserContent } from "./content.js";
import { MAX_TIMER_MS, ProviderError, withProviderAbort } from "./client.js";
import { cacheSettings } from "./cache.js";

/**
 * Beta of on-demand compaction: sent on the compaction request and on every request that carries its block
 * (https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand, checked 2026-10-11).
 */
export const ANTHROPIC_COMPACTION_BETA = "compact-2026-09-04";
/** The documented maximum length of compaction `instructions`, in characters. */
export const ANTHROPIC_COMPACTION_INSTRUCTIONS_LIMIT = 16384;
/**
 * Beta of `thinking.block_binding` and `input_transformations` (SDK 0.128 `BetaThinkingBlockBinding`); with
 * `prefix_mismatch_behavior: "drop_block"` the API drops thinking whose prefix changed instead of reading it.
 */
export const ANTHROPIC_THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** `owners[i]` is the index in `request.messages` of the assistant message that became wire message `i`. */
function inputMessages(request: { messages: readonly ModelMessage[] }, owners: Array<number | undefined> = []): MessageParam[] {
  const messages: MessageParam[] = [];
  /** Consecutive user entries are one user message: the tool results first, then your text and images (docs/providers.md). */
  const pushUser = (content: MessageParam["content"]) => {
    const last = messages.at(-1);
    if (last?.role !== "user") return void messages.push({ role: "user", content });
    const blocks = (value: MessageParam["content"]) => (typeof value === "string" ? value ? [{ type: "text" as const, text: value }] : [] : value);
    last.content = [...blocks(last.content), ...blocks(content)];
  };
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "user") {
      const parts = nativeUserContent(message.content);
      pushUser((parts.some((part) => part.type === "image")
        ? parts.flatMap((part): Array<Record<string, unknown>> => part.type === "image"
          ? [{ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }]
          : part.text ? [{ type: "text", text: part.text }] : [])
        : renderUserInput(message.content)) as MessageParam["content"]);
    }
    else if (message.role === "assistant") {
      const blocks = Array.isArray(message.opaque) ? message.opaque : [
        ...(message.text ? [{ type: "text", text: message.text }] : []),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ];
      owners[messages.length] = index;
      messages.push({ role: "assistant", content: blocks as MessageParam["content"] });
    } else {
      const result = nativeToolContent(message.result);
      const content: Array<Record<string, unknown>> = [];
      if (result.text) content.push({ type: "text", text: result.text });
      for (const image of result.images) content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
      pushUser([{ type: "tool_result", tool_use_id: message.callId, is_error: message.result.isError, content: content as never }]);
    }
  }
  return messages;
}

/** Request settings shared by ordinary and compaction requests, so a compaction sees what the main request sees. */
function sharedSettings(modelConfig: Readonly<ResolvedModelConfig>, request: { system: string; tools: ProviderRequest["tools"]; cacheKey?: string | undefined }) {
  const configured = modelConfig.request?.kind === "anthropic" ? modelConfig.request : undefined;
  const tools: Tool[] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: structuredClone(tool.inputSchema) as unknown as Tool["input_schema"] }));
  const cache = cacheSettings(modelConfig, request.cacheKey).anthropic;
  return {
    configured,
    tools,
    params: {
      // An explicit breakpoint after the system prompt keeps tools + system cached when the messages are rewritten
      // (compaction), next to the automatic marker that follows the conversation; both use the same TTL.
      system: cache && request.system
        ? [{ type: "text" as const, text: request.system, cache_control: structuredClone(cache.cache_control) }]
        : request.system,
      ...cache,
      ...(configured?.thinking ? { thinking: configured.thinking.type === "enabled"
        ? { type: "enabled" as const, budget_tokens: configured.thinking.budgetTokens }
        : { type: configured.thinking.type } } : {}),
      ...(configured?.effort ? { output_config: { effort: configured.effort } } : {}),
      ...(configured?.serviceTier ? { service_tier: configured.serviceTier } : {}),
      ...(tools.length ? { tools } : {}),
    },
  };
}

/**
 * The `thinking_dropped` entries of `input_transformations`, from wire `messages.{i}.content.{j}` paths to request message
 * indices; other entry types are ignored, as the SDK asks. Without the array (the beta was ignored) nothing was reported.
 */
function droppedBlocks(transformations: unknown, owners: ReadonlyArray<number | undefined>): ReplayedBlock[] | "unreported" {
  if (!Array.isArray(transformations)) return "unreported";
  return transformations.flatMap((entry: unknown): ReplayedBlock[] => {
    const { type, path } = (entry ?? {}) as { type?: unknown; path?: unknown };
    const match = type === "thinking_dropped" && typeof path === "string" ? /^messages\.(\d+)\.content\.(\d+)$/.exec(path) : null;
    const message = match ? owners[Number(match[1])] : undefined;
    return message === undefined ? [] : [{ message, block: Number(match![2]) }];
  });
}

export function createAnthropicProvider(modelConfig: Readonly<ResolvedModelConfig>): ProviderAdapter {
  const client = new Anthropic({
    apiKey: modelConfig.apiKey ?? "",
    ...(modelConfig.baseUrl ? { baseURL: modelConfig.baseUrl } : {}),
    timeout: MAX_TIMER_MS,
    maxRetries: 0,
  });
  return {
    modelConfig,
    /** On-demand compaction (design §6.9.1): the signed `compaction` block, exactly as returned. */
    async compact(request: NativeCompactRequest) {
      return withProviderAbort(request, async (signal, touch) => {
        const { configured, params } = sharedSettings(modelConfig, request);
        const maxTokens = request.maxOutputTokens ?? effectiveOutputTokens(modelConfig);
        if (configured?.thinking?.type === "enabled" && configured.thinking.budgetTokens >= maxTokens) {
          throw new ProviderError("invalid_request", "Anthropic thinking budget must be smaller than max output tokens");
        }
        const response = await client.beta.messages.create({
          model: modelConfig.model,
          max_tokens: maxTokens,
          messages: inputMessages(request) as never,
          betas: [ANTHROPIC_COMPACTION_BETA],
          compaction: { type: "summarize", ...(request.instructions ? { instructions: request.instructions } : {}) },
          ...params,
        } as never, { signal, maxRetries: 0 }) as unknown as {
          stop_reason?: unknown; content?: unknown; usage?: { iterations?: unknown } };
        touch();
        // The summary's own usage is the `compaction` iteration; the top-level counts are zero because nothing is answered.
        const iterations = Array.isArray(response.usage?.iterations) ? response.usage.iterations as Array<{ type?: unknown }> : [];
        const usage = iterations.find((entry) => entry?.type === "compaction") ?? response.usage;
        if (usage !== undefined && !signal.aborted) request.onUsage?.(usage);
        const blocks = Array.isArray(response.content) ? response.content as Array<Record<string, unknown>> : [];
        const block = blocks[0];
        if (response.stop_reason !== "compaction" || blocks.length !== 1 || block?.type !== "compaction"
          || typeof block.content !== "string" || !block.content) {
          throw new ProviderError("native_compaction", `Anthropic compaction returned no summary (stop reason: ${String(response.stop_reason)})`);
        }
        return { items: [structuredClone(block)], summary: block.content, ...(usage !== undefined ? { usage } : {}) };
      });
    },
    async generate(request): Promise<ProviderTurn> {
      return withProviderAbort(request, async (signal, touch, commit) => {
        const { configured, tools, params } = sharedSettings(modelConfig, request);
        // Anthropic requires max_tokens; an assumed default that an older model rejects is lowered to its stated maximum.
        const assumed = request.maxOutputTokens !== undefined ? request.maxOutputTokensAssumed === true
          : modelConfig.request?.maxOutputTokens === undefined && modelConfig.maxOutputTokens === undefined;
        let outputLimit = request.maxOutputTokens ?? effectiveOutputTokens(modelConfig);
        const checkThinking = () => {
          if (configured?.thinking?.type === "enabled" && configured.thinking.budgetTokens >= outputLimit) {
            throw new ProviderError("invalid_request", "Anthropic thinking budget must be smaller than max output tokens");
          }
        };
        checkThinking();
        // Only a request that configures thinking has a `thinking` object to carry the binding (SDK `BetaThinkingConfigEnabled`/`Adaptive`).
        const bind = request.dropStaleThinking === true && (configured?.thinking?.type === "enabled" || configured?.thinking?.type === "adaptive");
        // The API accepts a compaction block only with the compaction beta.
        const betas = [...request.messages.some((message) => isNativeCompaction(message)) ? [ANTHROPIC_COMPACTION_BETA] : [],
          ...bind ? [ANTHROPIC_THINKING_BINDING_BETA] : []];
        const beta = betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : {};
        const owners: Array<number | undefined> = [];
        const wireMessages = inputMessages(request, owners);
        const create = () => client.messages.create({
          model: modelConfig.model,
          max_tokens: outputLimit,
          messages: wireMessages,
          stream: true,
          ...params,
          ...(bind ? { thinking: { ...params.thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } } as unknown as typeof params.thinking } : {}),
          ...(tools.length && request.toolChoice ? { tool_choice: { type: request.toolChoice } } : {}),
        }, { signal, maxRetries: 0, ...beta });
        let stream: Awaited<ReturnType<typeof create>>;
        try { stream = await create(); }
        catch (error) {
          const allowed = assumed ? /max_tokens: \d+ > (\d+)/.exec(error instanceof Error ? error.message : "")?.[1] : undefined;
          if (allowed === undefined || Number(allowed) >= outputLimit || Number(allowed) < 1) throw error;
          outputLimit = Number(allowed);
          checkThinking();
          stream = await create();
        }
        const blocks = new Map<number, Record<string, unknown>>();
        const toolJson = new Map<number, string>();
        const activeBlocks = new Set<number>();
        const argumentErrors = new Map<number, string>();
        let text = "";
        let stopReason: string | undefined;
        let stopped = false;
        let started = false;
        let completed = false;
        let committed = false;
        const markCommitted = () => { committed = true; commit(); };
        let usage: Record<string, unknown> = {};
        // Final in `message_start`; a `message_delta` carries it only after a server-side model fallback, and then replaces it.
        let transformations: unknown;
        try {
        for await (const event of stream) {
          touch();
          if (signal.aborted) throw new ProviderError("aborted", "provider stream aborted");
          if (stopped) throw new ProviderError("invalid_stream", "Anthropic event after message stop");
          if (event.type === "message_start") {
            if (started) throw new ProviderError("invalid_stream", "duplicate Anthropic message start");
            started = true;
            usage = { ...event.message.usage };
            transformations = (event.message as { input_transformations?: unknown }).input_transformations;
          }
          else if (event.type === "content_block_start") {
            if (!started || blocks.has(event.index)) throw new ProviderError("invalid_stream", "invalid Anthropic block start");
            blocks.set(event.index, { ...event.content_block });
            activeBlocks.add(event.index);
            if (event.content_block.type === "text" && event.content_block.text) {
              text += event.content_block.text;
              markCommitted();
              request.onTextDelta?.(event.content_block.text);
            }
          }
          else if (event.type === "content_block_delta") {
            const block = blocks.get(event.index);
            if (!block || !activeBlocks.has(event.index)) throw new ProviderError("invalid_stream", "content delta outside active block");
            const delta = event.delta;
            if (delta.type === "text_delta") {
              if (block.type !== "text") throw new ProviderError("invalid_stream", "text delta on nontext block");
              block.text = String(block.text ?? "") + delta.text;
              text += delta.text;
              if (delta.text) { markCommitted(); request.onTextDelta?.(delta.text); }
            } else if (delta.type === "thinking_delta") {
              if (block.type !== "thinking") throw new ProviderError("invalid_stream", "thinking delta on nonthinking block");
              block.thinking = String(block.thinking ?? "") + delta.thinking;
              if (delta.thinking) { markCommitted(); request.onReasoningDelta?.(delta.thinking); }
            } else if (delta.type === "signature_delta") {
              if (block.type !== "thinking") throw new ProviderError("invalid_stream", "signature delta on nonthinking block");
              block.signature = String(block.signature ?? "") + delta.signature;
            } else if (delta.type === "input_json_delta") {
              if (block.type !== "tool_use") throw new ProviderError("invalid_stream", "tool JSON delta on nontool block");
              toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json);
            }
          } else if (event.type === "content_block_stop") {
            if (!activeBlocks.delete(event.index)) throw new ProviderError("invalid_stream", "Anthropic block stop without start");
          } else if (event.type === "message_delta") {
            if (!started || activeBlocks.size) throw new ProviderError("invalid_stream", "Anthropic message delta before blocks complete");
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
            usage = { ...usage, ...event.usage };
            const replaced = (event as { input_transformations?: unknown }).input_transformations;
            if (replaced !== undefined && replaced !== null) transformations = replaced;
          } else if (event.type === "message_stop") {
            if (!started || activeBlocks.size) throw new ProviderError("invalid_stream", "Anthropic message stopped with incomplete blocks");
            stopped = true;
          }
        }
        if (!started || !stopped || !stopReason) throw new ProviderError("incomplete_stream", "Anthropic stream ended without terminal event");
        const truncated = stopReason === "max_tokens" || stopReason === "model_context_window_exceeded";
        if (!truncated && stopReason !== "end_turn" && stopReason !== "tool_use") throw new ProviderError("provider_finish", `Anthropic stop reason: ${stopReason}`);
        // A thinking block cut before its signature cannot be sent back; the rest of a truncated turn can.
        const orderedBlocks = [...blocks].sort(([a], [b]) => a - b)
          .filter(([, block]) => !(truncated && block.type === "thinking" && !block.signature));
        const opaque = orderedBlocks.map(([index, block]) => {
          if (block.type === "tool_use" && toolJson.has(index)) {
            try { block.input = JSON.parse(toolJson.get(index)!); }
            catch { argumentErrors.set(index, truncated ? truncatedArgumentsError(String(block.name)) : "Anthropic tool arguments are invalid JSON"); block.input = {}; }
            if (!argumentErrors.has(index) && (!block.input || typeof block.input !== "object" || Array.isArray(block.input))) {
              argumentErrors.set(index, "Anthropic tool arguments must be an object");
              block.input = {};
            }
          }
          return block;
        });
        const toolCalls: ModelToolCall[] = orderedBlocks.flatMap(([index, block]) => {
          if (block.type !== "tool_use") return [];
          if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
            throw new ProviderError("invalid_stream", "Anthropic tool call linkage invalid");
          }
          const argumentError = argumentErrors.get(index);
          return [{ id: block.id, name: block.name, arguments: block.input as Record<string, unknown>,
            ...(argumentError ? { argumentError, rawArguments: toolJson.get(index)! } : {}) }];
        });
        if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new ProviderError("invalid_stream", "duplicate Anthropic tool call ID");
        if (stopReason === "tool_use" && !toolCalls.length) throw new ProviderError("invalid_stream", "tool stop without calls");
        if (stopReason === "end_turn" && toolCalls.length) throw new ProviderError("invalid_stream", "tool calls with end_turn stop");
        completed = true;
        return { text, toolCalls, finishReason: stopReason, ...(truncated ? { truncated } : {}), opaque, usage,
          ...(request.dropStaleThinking ? { droppedThinking: bind ? droppedBlocks(transformations, owners) : "unreported" as const } : {}) };
        } finally {
          if (!signal.aborted && (completed || committed) && Object.keys(usage).length) request.onUsage?.(usage);
        }
      });
    },
  };
}
