/**
 * Single source of truth for every cacheable GET the dashboard performs.
 * A key is the API path itself, so the shared SWR `fetcher` can request it verbatim
 * and `mutate(keys.x())` always addresses exactly what a hook reads.
 */
const enc = encodeURIComponent;

export interface SessionsQuery {
  cwd: string;
  title: string;
  limit?: number;
  before?: string;
}

export const keys = {
  bootstrap: () => "/bootstrap",
  config: () => "/config",
  activity: () => "/activity",
  workspaces: () => "/workspaces",
  workspaceFiles: (cwd: string, refresh = false) => `/workspaces/files?cwd=${enc(cwd)}${refresh ? "&refresh=1" : ""}`,
  workspaceFile: (cwd: string, path: string) => `/workspaces/file?cwd=${enc(cwd)}&path=${enc(path)}`,
  workspaceImage: (cwd: string, path: string) => `/workspaces/file?cwd=${enc(cwd)}&path=${enc(path)}&raw=1`,
  sessions: ({ cwd, title, limit = 50, before }: SessionsQuery) =>
    `/sessions?cwd=${enc(cwd)}&title=${enc(title)}&limit=${limit}${before ? `&before=${enc(before)}` : ""}`,
  composer: (agent: string) => `/agents/${enc(agent)}/composer`,
  components: (kind: string) => `/components/${enc(kind)}`,
  packages: () => "/packages",
  packageStages: () => "/packages/stages",
} as const;
