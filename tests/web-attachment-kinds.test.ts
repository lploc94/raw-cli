import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptAttribute, clientKinds, kindForMime, transferLinks, type KindMeta } from "../web/src/composer/attachment-kinds.js";

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

const image: KindMeta = { id: "image", accept: ["image/png", "image/jpeg"], maxBytes: 8, enabled: true };
const file: KindMeta = { id: "file", accept: ["*/*"], maxBytes: 16, enabled: true };

test("a kind accepting any type takes what no other kind lists, never a type another kind lists", () => {
  for (const [mime, kind] of [["image/png", "image"], ["image/jpeg", "image"], ["image/gif", "file"], ["application/pdf", "file"], ["", "file"]] as const) {
    assert.equal(kindForMime([file, image], mime)?.id, kind, `${JSON.stringify(mime)} goes to ${kind}, whatever the order`);
  }
  assert.equal(kindForMime([image, { ...file, enabled: false }], "application/pdf"), undefined, "a disabled catch-all takes nothing");
});

test("the file picker accepts any file once a kind takes any type", () => {
  assert.equal(acceptAttribute([image, file]), "");
  assert.equal(acceptAttribute([image]), "image/png,image/jpeg");
  assert.equal(acceptAttribute([]), "image/png,image/jpeg", "no metadata yet: images, as before");
});

/** A DataTransfer stand-in: only `getData` is read. */
const transfer = (uriList: string | undefined) => ({ getData: (type: string) => (type === "text/uri-list" && uriList !== undefined ? uriList : "") }) as unknown as DataTransfer;
const files = (count: number) => Array.from({ length: count }, (_value, index) => ({ name: `f${index}` }) as File);

test("each dropped file gets the link at its position only when the browser gave one link per file", () => {
  const two = "# dragged from the editor\r\nfile:///work/a.csv\r\nfile:///work/b%20c.pdf\r\n";
  assert.deepEqual(transferLinks(transfer(two), files(2)), { links: ["file:///work/a.csv", "file:///work/b%20c.pdf"],
    sources: ["file:///work/a.csv", "file:///work/b%20c.pdf"] });
  assert.deepEqual(transferLinks(transfer("https://example.com/x.png"), files(2)).sources, [undefined, undefined], "a count that differs pairs nothing");
  assert.deepEqual(transferLinks(transfer(undefined), files(1)), { links: [], sources: [undefined] }, "no links: no sources");
  assert.deepEqual(transferLinks(transfer("file:///work/only.txt"), []), { links: ["file:///work/only.txt"], sources: [] }, "links without files");
});

test("a link the server would drop is never sent as a source, so a long data: URL cannot fail the upload", () => {
  const dataUrl = `data:image/png;base64,${"A".repeat(20000)}`;
  assert.deepEqual(transferLinks(transfer(dataUrl), files(1)).sources, [undefined], "a data: URL of an image dragged from a page");
  const long = `https://example.com/${"a".repeat(3000)}`;
  assert.deepEqual(transferLinks(transfer(long), files(1)).sources, [undefined], "a link over 2048 characters");
  assert.deepEqual(transferLinks(transfer("javascript:alert(1)"), files(1)).sources, [undefined]);
  const kept = `https://example.com/${"a".repeat(2048 - 20)}`;
  assert.equal(kept.length, 2048);
  assert.deepEqual(transferLinks(transfer(kept), files(1)).sources, [kept], "2048 characters is kept, as the server keeps it");
});
