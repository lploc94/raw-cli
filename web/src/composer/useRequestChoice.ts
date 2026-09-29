import { useCallback, useEffect, useState } from "react";
import {
  pruneChoice,
  readChoice,
  requestBody,
  writeChoice,
  type RequestBody,
  type RequestChoice,
  type RequestControlMeta,
} from "./request-choice.js";

/**
 * The session's remembered choice. `loadedFor` is the agent whose controls have loaded; pruning and sending wait for it, so a slow or failed metadata fetch neither erases the choice nor sends it.
 */
export function useRequestChoice(
  session: string,
  agent: string,
  controls: RequestControlMeta[],
  loadedFor: string,
) {
  const [choice, setChoice] = useState<RequestChoice>(() => readChoice(session));
  useEffect(() => setChoice(readChoice(session)), [session]);
  const ready = !!agent && loadedFor === agent;
  useEffect(() => {
    if (!ready) return;
    setChoice((current) => {
      const kept = pruneChoice(current, controls);
      if (Object.keys(kept).length === Object.keys(current).length) return current;
      writeChoice(session, kept);
      return kept;
    });
  }, [ready, controls, session]);
  const update = useCallback(
    (next: RequestChoice) => {
      setChoice(next);
      writeChoice(session, next);
    },
    [session],
  );
  const body: RequestBody | undefined = ready ? requestBody(choice, controls) : undefined;
  return { choice, update, body, ready };
}
