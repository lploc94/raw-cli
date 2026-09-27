import { RE2JS } from "re2js";
import { compileWhen, matchesWhen } from "../tools/policy.js";
import { hookEvents, toolHookEvents, type HookEventName, type HookManifest, type HookSubscription } from "./contract.js";

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${where} field: ${key}`);
}
function boundedString(value: unknown, where: string, limit = 256): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > limit) throw new Error(`${where} must be a bounded string`);
  return value;
}
function glob(pattern: string): RE2JS {
  const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "."
    : char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&")).join("");
  return RE2JS.compile(`^(?:${source})$`, RE2JS.DOTALL);
}

export function parseHookManifest(raw: unknown, id: string, expectedName: string): HookManifest {
  const value = object(raw, `hook ${id}`);
  fields(value, ["name", "events", "command", "args", "timeout_ms"], `hook ${id}`);
  const name = boundedString(value.name, `${id}.name`, 64);
  if (name !== expectedName || !/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid hook name: ${id}`);
  if (!Array.isArray(value.events) || !value.events.length || value.events.length > 32) throw new Error(`${id}.events must be a nonempty bounded array`);
  const events = value.events.map((entry, index): HookSubscription => {
    const where = `${id}.events[${index}]`;
    const item = object(entry, where);
    fields(item, ["name", "match", "when"], where);
    if (typeof item.name !== "string" || !hookEvents.includes(item.name as HookEventName)) throw new Error(`invalid hook event: ${where}`);
    const event = item.name as HookEventName;
    if (!toolHookEvents.has(event) && (item.match !== undefined || item.when !== undefined)) throw new Error(`${where} match/when requires a tool event`);
    const match = item.match === undefined ? undefined : boundedString(item.match, `${where}.match`);
    if (match !== undefined) glob(match);
    let when: HookSubscription["when"];
    if (item.when !== undefined) {
      const predicate = object(item.when, `${where}.when`);
      fields(predicate, ["any", "regex"], `${where}.when`);
      when = { any: boundedString(predicate.any, `${where}.when.any`),
        regex: boundedString(predicate.regex, `${where}.when.regex`, 1024) };
      compileWhen(when);
    }
    return { name: event, ...(match ? { match } : {}), ...(when ? { when } : {}) };
  });
  const command = boundedString(value.command, `${id}.command`, 1024);
  if (command.startsWith(".") && !command.startsWith("./")) throw new Error(`invalid hook command: ${id}`);
  if (!command.startsWith("./") && (command.includes("/") || command.includes("\\"))) throw new Error(`hook command must be on PATH or inside folder: ${id}`);
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg) > 4096)) {
    throw new Error(`invalid hook args: ${id}`);
  }
  const timeoutMs = value.timeout_ms === undefined ? 5000 : value.timeout_ms;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 30000) {
    throw new Error(`invalid hook timeout_ms: ${id}`);
  }
  return { name, events, command, args: args as string[], timeoutMs: timeoutMs as number };
}

export function matchesHookSubscription(subscription: HookSubscription, event: HookEventName,
  identity?: string, args?: Record<string, unknown>): boolean {
  if (subscription.name !== event) return false;
  if (subscription.match && (identity === undefined || !glob(subscription.match).matches(identity))) return false;
  if (subscription.when && (args === undefined || !matchesWhen(compileWhen(subscription.when), args))) return false;
  return true;
}
