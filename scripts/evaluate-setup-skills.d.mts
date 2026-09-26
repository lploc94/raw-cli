import type { ProviderAdapter, ModelMessage } from "../src/llm/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import type { SelectedSkill } from "../src/skills/contract.js";
export interface Identity { catalog: string; bodies: Record<string, string>; case: string; system: string; model: string; runner: string }
export function fingerprint(input: { skills: Array<{ name: string; description: string; markdown: string; [key: string]: unknown }>; caseSpec: unknown; system: string; model: unknown; runner: string }): Identity;
export function isFresh(result: { identity: Identity; expected: string[]; loaded: string[] }, current: Identity): boolean;
export function sanitizeReport(value: unknown, secrets?: string[]): unknown;
export function cleanEnvironment(input: { home: string; bin: string }): Record<string, string>;
export function reserveAttempt(output: string, variant: string, id: string): number;
export function preservedSnapshot(spec: { kind: string; id: string }, before: Record<string, string>, after: Record<string, string>, configRelative: string): boolean;
export function gradeRun(input: { caseSpec: { kind: string; skill: string | null }; transcript: unknown[]; status: string; artifacts?: Array<{ name: string; pass: boolean }>; unchanged: boolean; sentinels?: string[] }): { pass: boolean; checks: Array<{ name: string; pass: boolean }>; expected: string[]; loaded: string[]; toolCalls: number };
export function runTurn(options: { provider: ProviderAdapter; registry: ToolRegistry; skills: readonly SelectedSkill[]; system: string; cwd: string; input: string; deadlineMs?: number }): Promise<{ result: { status: string; text?: string }; transcript: readonly ModelMessage[]; requests: unknown[]; events: unknown[]; usage: unknown }>;
