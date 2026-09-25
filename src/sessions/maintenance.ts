import type { SessionStore } from "./store.js";

export interface SessionMaintenanceOptions {
  maxSessions?: number;
  maxOrphanEntries?: number;
  maxPages?: number;
  sweepOrphans?: boolean;
  reclaim?: boolean;
}

export interface SessionMaintenanceResult {
  expiredDeleted: number;
  orphanFilesDeleted: number;
  checkpointed: boolean;
  pagesReclaimed: number;
}

export function runSessionMaintenance(store: SessionStore, options: SessionMaintenanceOptions = {}): SessionMaintenanceResult {
  const expiredDeleted = store.cleanupExpired(options.maxSessions);
  const orphanFilesDeleted = options.sweepOrphans === false ? 0 : store.sweepOrphans(options.maxOrphanEntries);
  const { checkpointed, pagesReclaimed } = options.reclaim === false
    ? { checkpointed: false, pagesReclaimed: 0 } : store.reclaimIdleStorage(options.maxPages);
  return { expiredDeleted, orphanFilesDeleted, checkpointed, pagesReclaimed };
}
