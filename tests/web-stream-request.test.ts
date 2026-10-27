import assert from "node:assert/strict";
import test from "node:test";
import { eventsRequest } from "../web/src/stream-request.js";

for (const remote of [true, false, undefined]) {
  for (const cursor of [undefined, "epoch-1:42"]) {
    for (const sessionId of ["plain", "a/b c?d#e"]) {
      test(`events request remote=${remote} cursor=${cursor ?? "none"} session=${sessionId}`, () => {
        const { path, init } = eventsRequest({ sessionId, cursor, token: "tok-1", remote });
        assert.equal(path, `/api/sessions/${encodeURIComponent(sessionId)}/events`);
        assert.equal(init.method, remote === true ? "POST" : "GET");
        assert.deepEqual(init.headers, { Authorization: "Bearer tok-1", ...(cursor ? { "Last-Event-ID": cursor } : {}) });
      });
    }
  }
}
