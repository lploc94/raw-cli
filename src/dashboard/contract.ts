export const DASHBOARD_API_VERSION = 1;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_REPLAY_FRAMES = 4096;
export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
export interface ApiErrorBody { error: { code: string; message: string; details?: unknown } }
export interface DashboardBootstrap {
  apiVersion: number;
  version: string;
  instanceId: string;
  cwd: string;
  configPath: string;
  preferredAgent?: string;
  config: {
    exists: boolean; revision?: string; canonical?: boolean; valid: boolean;
    diagnostic?: string; agents: string[]; models: string[]; defaultAgent?: string;
  };
  store: { available: boolean; diagnostic?: string };
}
export function isDashboardPage(path: string): boolean {
  return path === "/" || /^\/chat(?:\/[^/]+)?\/?$/.test(path)
    || /^\/agents(?:\/[^/]+)?\/?$/.test(path)
    || /^\/library(?:\/(?:tools|skills|vars|mcp|packages)(?:\/[^/]+)?)?\/?$/.test(path)
    || /^\/settings(?:\/(?:general|models|appearance|chat|sessions|diagnostics))?\/?$/.test(path);
}
