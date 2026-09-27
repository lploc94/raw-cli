import { HookError, type HookEventName, type HookRequest, type SelectedHook } from "./contract.js";
import { matchesHookSubscription } from "./manifest.js";
import { runHook } from "./runner.js";
import { bindWhenToSchema, compileWhen } from "../tools/policy.js";
import type { ToolRegistry } from "../tools/registry.js";

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
    for (const hook of this.selected) for (const subscription of hook.events) {
      if (!subscription.when) continue;
      for (const tool of registry.definitions(visibleNames)) {
        const identity = registry.canonicalIdentity(tool.name) ?? tool.name;
        if (matchesHookSubscription({ name: subscription.name,
          ...(subscription.match ? { match: subscription.match } : {}) }, subscription.name, identity)) {
          bindWhenToSchema(compileWhen(subscription.when), tool);
        }
      }
    }
  }

  async run(event: HookEventName, request: Omit<HookRequest, "protocol_version" | "event">,
    options: { signal?: AbortSignal; deadline?: number; onReceipt?: (receipt: HookReceipt) => void } = {}): Promise<HookDispatchResult> {
    const gate = event === "UserPromptSubmit" || event === "PreToolUse";
    for (const hook of this.selected) {
      if (!hook.events.some((item) => matchesHookSubscription(item, event, request.tool?.identity, request.tool?.arguments))) continue;
      if (options.signal?.aborted) return gate ? { blocked: "error", reason: "hook aborted" } : {};
      if (options.deadline !== undefined && Date.now() >= options.deadline) break;
      const started = performance.now();
      let receipt: HookReceipt;
      let denial: string | undefined;
      try {
        const response = await runHook(hook, { protocol_version: 1, event, ...request }, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.deadline !== undefined ? { timeoutMs: Math.max(1, options.deadline - Date.now()) } : {}),
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
