import { HookError, type HookEventName, type HookRequest, type SelectedHook } from "./contract.js";
import { matchesHookSubscription } from "./manifest.js";
import { runHook } from "./runner.js";
import { bindWhenToSchema, compileWhen } from "../tools/policy.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";

export interface HookReceipt {
  id: string;
  event: HookEventName;
  outcome: "continued" | "denied" | "error";
  durationMs: number;
  message?: string;
  code?: string;
}
export interface HookDispatchResult { blocked?: "denied" | "error"; reason?: string }

export class HookDispatcher {
  constructor(readonly selected: readonly SelectedHook[], private readonly env?: NodeJS.ProcessEnv) {}

  validateTools(registry: ToolRegistry, visibleNames: readonly string[]): void {
    for (const tool of registry.definitions(visibleNames)) this.validateTool(registry.canonicalIdentity(tool.name) ?? tool.name,
      registry.inspectionDefinition(tool.name)!);
  }

  validateTool(identity: string, definition: ToolDefinition): void {
    for (const hook of this.selected) for (const subscription of hook.events) {
      if (!subscription.when) continue;
      if (matchesHookSubscription({ name: subscription.name,
          ...(subscription.match ? { match: subscription.match } : {}) }, subscription.name, identity)) {
        bindWhenToSchema(compileWhen(subscription.when), definition);
      }
    }
  }

  async run(event: HookEventName, request: Omit<HookRequest, "protocol_version" | "event">,
    options: { signal?: AbortSignal; deadline?: number; onReceipt?: (receipt: HookReceipt) => void;
      /** An interruption: once it aborts, the remaining hooks of this event share `graceMs` instead of their own timeouts. */
      hurry?: { signal: AbortSignal; graceMs: number } } = {}): Promise<HookDispatchResult> {
    const gate = event === "UserPromptSubmit" || event === "PreToolUse";
    let deadline = options.deadline;
    for (const hook of this.selected) {
      if (gate && hook.events.some(item => item.when?.source === "effects"
        && matchesHookSubscription({ name: item.name, ...(item.match ? { match: item.match } : {}) }, event, request.tool?.identity))
        && request.tool?.effects === undefined) return { blocked: "error", reason: `hook ${hook.id}: effects inspection unavailable` };
      if (!hook.events.some((item) => matchesHookSubscription(item, event, request.tool?.identity, request.tool?.arguments, request.tool?.effects))) continue;
      if (options.signal?.aborted) return gate ? { blocked: "error", reason: "hook aborted" } : {};
      if (options.hurry?.signal.aborted) deadline = Math.min(deadline ?? Infinity, Date.now() + options.hurry.graceMs);
      if (deadline !== undefined && Date.now() >= deadline) break;
      const started = performance.now();
      let receipt: HookReceipt;
      let denial: string | undefined;
      try {
        const response = await runHook(hook, { protocol_version: 2, event, ...request }, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(deadline !== undefined ? { timeoutMs: Math.max(1, deadline - Date.now()) } : {}),
          ...(options.hurry ? { hurry: options.hurry } : {}),
          ...(this.env ? { env: this.env } : {}),
        });
        receipt = { id: hook.id, event, outcome: response.decision === "deny" ? "denied" : "continued",
          durationMs: response.durationMs, ...(response.message ? { message: response.message } : {}) };
        if (response.decision === "deny") denial = response.reason ?? `hook ${hook.id} denied`;
      } catch (error) {
        const code = error instanceof HookError ? error.code : "hook_callback";
        receipt = { id: hook.id, event, outcome: "error", durationMs: Math.round(performance.now() - started), code };
      }
      options.onReceipt?.(receipt);
      if (receipt.outcome === "error" && gate) return { blocked: "error", reason: `hook ${hook.id} failed: ${receipt.code}` };
      if (denial) return gate ? { blocked: "denied", reason: denial } : {};
    }
    return {};
  }
}
