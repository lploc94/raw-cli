import useSWR, { preload } from "swr";
import useSWRInfinite, { type SWRInfiniteKeyedMutator } from "swr/infinite";
import type { DashboardBootstrap } from "../../../src/dashboard/contract.js";
import type { ConfigView } from "../../../src/dashboard/management.js";
import type { PackageStageView, PackageView } from "../../../src/dashboard/packages.js";
import type { ComponentInfo } from "../../../src/management/components.js";
import type { Page, SessionSummary } from "../../../src/sessions/store.js";
import type { KindMeta } from "../composer/attachment-kinds.js";
import type { ComposerSkill } from "../composer/commands.js";
import type { RequestControlMeta } from "../composer/request-choice.js";
import { api } from "../api.js";
import { keys } from "./keys.js";

export interface ActivityView {
  operations: Array<{
    id: string;
    sessionId: string;
    state: string;
    kind: string;
    controllable: boolean;
  }>;
  approvals: Array<{ id: string; sessionId: string; name: string }>;
}
const idleActivity: ActivityView = { operations: [], approvals: [] };

export interface ComposerMeta {
  vision: boolean;
  skills: ComposerSkill[];
  controls: RequestControlMeta[];
  attachmentKinds: KindMeta[];
}
export const emptyComposerMeta: ComposerMeta = {
  vision: false,
  skills: [],
  controls: [],
  attachmentKinds: [],
};

export function useBootstrap() {
  return useSWR<DashboardBootstrap>(keys.bootstrap());
}

/** One shared `/config` for every management page, so navigating between them never refetches. */
export function useConfig() {
  return useSWR<ConfigView>(keys.config());
}

export function usePackages() {
  return useSWR<PackageView[]>(keys.packages());
}
export function usePackageStages() {
  return useSWR<PackageStageView[]>(keys.packageStages());
}

export function useComponents(kind: string) {
  return useSWR<ComponentInfo[]>(keys.components(kind));
}

/** Composer capabilities per agent. Cached, so switching agents/chats never blanks the controls. */
export function useComposerMeta(agent: string) {
  const swr = useSWR<ComposerMeta>(agent ? keys.composer(agent) : null, {
    // Old agent's controls must not leak into the next agent while it loads.
    keepPreviousData: false,
  });
  return {
    ...swr,
    meta: swr.data
      ? { ...swr.data, controls: swr.data.controls ?? [] }
      : emptyComposerMeta,
    metaFor: swr.data ? agent : "",
  };
}
/** Warm the cache ahead of navigation (hover/focus); failures are ignored. */
export function prefetchComposerMeta(agent: string): void {
  if (agent) void preload(keys.composer(agent), (path: string) => api(path)).catch(() => {});
}

/** Management pages all read `/config`; warm it when the user hovers a nav link. */
export function prefetchConfig(): void {
  void preload(keys.config(), (path: string) => api(path)).catch(() => {});
}

/**
 * Polls `/activity` while the tab is visible. Errors are swallowed on purpose: session and
 * management requests already surface their own contextual connection errors.
 */
export function useActivity(enabled: boolean) {
  const swr = useSWR<ActivityView>(enabled ? keys.activity() : null, {
    refreshInterval: 2000,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    dedupingInterval: 1000,
    errorRetryCount: 0,
  });
  return swr.data ?? idleActivity;
}

export interface SessionList {
  items: SessionSummary[];
  nextCursor: string | undefined;
  /** True only for the very first load; background refreshes keep showing cached rows. */
  isLoading: boolean;
  isLoadingMore: boolean;
  error: unknown;
  loadMore: () => void;
  mutate: SWRInfiniteKeyedMutator<Page<SessionSummary>[]>;
}

/** Paged session list. Filter/workspace changes keep the previous rows until the new ones land. */
export function useSessions(cwd: string, title: string, enabled: boolean): SessionList {
  const swr = useSWRInfinite<Page<SessionSummary>>(
    (index, previous) => {
      if (!enabled || !cwd) return null;
      if (index === 0) return keys.sessions({ cwd, title });
      if (!previous?.nextCursor) return null;
      return keys.sessions({ cwd, title, before: previous.nextCursor });
    },
    { revalidateFirstPage: true, keepPreviousData: true, revalidateOnFocus: true },
  );
  const pages = swr.data ?? [];
  const last = pages[pages.length - 1];
  return {
    items: pages.flatMap((page) => page.items),
    nextCursor: last?.nextCursor,
    isLoading: swr.isLoading,
    isLoadingMore: swr.isValidating && swr.size > pages.length,
    error: swr.error,
    loadMore: () => void swr.setSize((size) => size + 1),
    mutate: swr.mutate,
  };
}
