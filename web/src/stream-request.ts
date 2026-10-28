/** The request that opens a session's event stream. A quick tunnel buffers GET event streams but streams POST bodies, so a remote dashboard asks with POST. */
export function eventsRequest(input: {
  sessionId: string;
  cursor: string | undefined;
  token: string;
  remote: boolean | undefined;
}): { path: string; init: { method: "GET" | "POST"; headers: Record<string, string> } } {
  return {
    path: `/api/sessions/${encodeURIComponent(input.sessionId)}/events`,
    init: {
      method: input.remote === true ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(input.cursor ? { "Last-Event-ID": input.cursor } : {}),
      },
    },
  };
}
