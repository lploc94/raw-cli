import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshFromSnapshot } from "../web/src/session-refresh.js";

const old = {
  session: { id: "s", title: "Old" }, context: { estimatedTokens: 1 }, metrics: null, metricsStale: false,
  backendOptions: [{ id: "backend_model" }], backendCommands: [{ name: "old", description: "Old" }], other: "kept",
};
const base = { session: { id: "s", title: "New" }, context: { estimatedTokens: 2 }, metrics: null, metricsStale: true };

test("a refresh takes the snapshot's command list as it is: absent clears it, empty stays empty, a list replaces it", () => {
  const absent = refreshFromSnapshot(old as never, base as never) as unknown as typeof old;
  assert.equal(absent.backendCommands, undefined);
  assert.ok(Object.hasOwn(absent, "backendCommands"));
  assert.deepEqual(absent.session, base.session);
  assert.equal(absent.metricsStale, true);
  assert.equal(absent.other, "kept");
  const empty = refreshFromSnapshot(old as never, { ...base, backendCommands: [] } as never) as unknown as typeof old;
  assert.deepEqual(empty.backendCommands, []);
  const list = [{ name: "status", description: "Status" }];
  assert.deepEqual((refreshFromSnapshot(old as never, { ...base, backendCommands: list } as never) as unknown as typeof old).backendCommands, list);
});

test("a refresh keeps the backend options when the snapshot has none, as before", () => {
  assert.deepEqual((refreshFromSnapshot(old as never, base as never) as unknown as typeof old).backendOptions, old.backendOptions);
  const options = [{ id: "backend_effort" }];
  assert.deepEqual((refreshFromSnapshot(old as never, { ...base, backendOptions: options } as never) as unknown as typeof old).backendOptions, options);
});
