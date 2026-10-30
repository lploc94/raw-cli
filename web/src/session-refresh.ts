import type { SessionSnapshot } from "../../src/dashboard/sessions.js";

/** What a refetched snapshot replaces in the chat's state after a turn. */
export type SnapshotRefresh = Pick<SessionSnapshot, "session" | "context" | "metrics" | "metricsStale" | "backendOptions" | "backendCommands">;

/**
 * The chat's state after a turn, from the session's snapshot. The backend options stay when the snapshot has none (a
 * turn may not have asked the CLI); the command list is the snapshot's as it is, so a list of a CLI conversation the
 * session has replaced goes away and the menu falls back to what a new conversation lists.
 */
export function refreshFromSnapshot<T extends SnapshotRefresh>(old: T, snapshot: SnapshotRefresh): T {
  return {
    ...old,
    session: snapshot.session,
    context: snapshot.context,
    metrics: snapshot.metrics,
    metricsStale: snapshot.metricsStale,
    // A backend turn may have changed what the CLI lists (Claude's efforts follow the model).
    ...(snapshot.backendOptions ? { backendOptions: snapshot.backendOptions } : {}),
    backendCommands: snapshot.backendCommands,
  };
}
