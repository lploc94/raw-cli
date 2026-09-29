import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKinds, kindForMime, type KindMeta } from "../web/src/composer/attachment-kinds.js";

// The client registry is what chips, upload, drag-drop, paste and the timeline dispatch through: a new kind needs only an entry here.
test("a kind registered later is selected by mime and rendered by the timeline with no composer change", () => {
  const metas: KindMeta[] = [
    { id: "image", accept: ["image/png", "image/jpeg"], maxBytes: 8, enabled: true },
    { id: "pdf", accept: ["application/pdf"], maxBytes: 16, enabled: true },
    { id: "off", accept: ["audio/wav"], maxBytes: 1, enabled: false },
  ];
  assert.equal(kindForMime(metas, "application/pdf")?.id, "pdf");
  assert.equal(kindForMime(metas, "audio/wav"), undefined, "a disabled kind is not selectable");
  assert.equal(kindForMime(metas, "text/plain"), undefined);
  assert.equal(clientKinds.get("pdf"), undefined);
  clientKinds.register({ id: "pdf", label: "PDF", icon: null, timeline: (attachment) => `pdf:${attachment.name}` });
  const rendered = clientKinds.get("pdf")!.timeline({ index: 0, kind: "pdf", name: "a.pdf", mimeType: "application/pdf", byteSize: 3 }, "s", 1);
  assert.equal(rendered, "pdf:a.pdf");
  clientKinds.unregister("pdf");
  assert.equal(clientKinds.get("pdf"), undefined);
});
