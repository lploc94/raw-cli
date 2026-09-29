import type { ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import { ApiError, api } from "../api.js";

/** Client errors (4xx) are deterministic; retrying them only delays the message. */
export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

export const swrConfig: SWRConfiguration = {
  fetcher: (path: string) => api(path),
  // Serve cached data instantly, revalidate in the background.
  revalidateIfStale: true,
  revalidateOnReconnect: true,
  // Individual hooks opt in; blanket refetch-on-focus could clobber unsaved drafts.
  revalidateOnFocus: false,
  keepPreviousData: true,
  dedupingInterval: 2000,
  errorRetryCount: 3,
  onErrorRetry(error, _key, _config, revalidate, { retryCount }) {
    if (!retryable(error) || retryCount >= 3) return;
    setTimeout(() => void revalidate({ retryCount }), Math.min(1000 * 2 ** retryCount, 8000));
  },
};

/**
 * Cache lives in memory only: it holds bearer-authenticated session data, so it is never
 * persisted. Tests pass a fresh `provider` to isolate cache between cases.
 */
export function DataProvider({
  children,
  provider,
}: {
  children: ReactNode;
  provider?: () => Map<string, never>;
}) {
  return (
    <SWRConfig value={provider ? { ...swrConfig, provider } : swrConfig}>
      {children}
    </SWRConfig>
  );
}
