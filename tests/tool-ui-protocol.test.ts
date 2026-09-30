import test from "node:test";
import assert from "node:assert/strict";
import { validateDeclaration, validateDocument } from "../src/panels/validate.js";
import { PANEL_PROTOCOL } from "../src/panels/contract.js";
import { resolveAction } from "../src/panels/actions.js";

test("one panel contract supports chat/sidebar and rejects unknown placement", () => {
  assert.equal(PANEL_PROTOCOL, "raw.panel/2");
  assert.equal(validateDeclaration({ id: "view", title: "View", placement: "chat" }, "view").placement, "chat");
  assert.equal(validateDeclaration({ id: "view", title: "View" }, "view").placement, "sidebar");
  assert.throws(() => validateDeclaration({ id: "view", title: "View", placement: "popup" }, "view"));
});

test("forms validate option identity, field bounds and block-scoped responses", () => {
  const field = { id: "choice", label: "Choose", kind: "single_select", required: true,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const document = (fields: unknown[]) => ({ blocks: [{ id: "question", kind: "form", fields }] });
  assert.doesNotThrow(() => validateDocument(document([field])));
  assert.throws(() => validateDocument(document([{ ...field, options: [{ id: "a", label: "A" }, { id: "a", label: "Duplicate" }] }])));
  assert.throws(() => validateDocument(document([field, field])));
  assert.throws(() => validateDocument(document([])));
  assert.throws(() => validateDocument(document([{ id: "text", kind: "text", label: "Text", max_bytes: 8193 }])));
  assert.doesNotThrow(() => validateDeclaration({ id: "question", title: "Question", actions: [
    { id: "submit", label: "Submit", scope: "block", blocks: ["question"], kind: "response", response: "submit" },
  ] }, "question"));
  assert.throws(() => validateDeclaration({ id: "question", title: "Question", actions: [
    { id: "submit", label: "Submit", scope: "item", kind: "response", response: "submit" },
  ] }, "question"));
  const declaration = validateDeclaration({ id: "question", title: "Question", actions: [
    { id: "submit", label: "Submit", scope: "block", kind: "response", response: "submit" },
  ] }, "question");
  assert.throws(() => resolveAction(declaration, { action: "submit", block: "other" },
    { blocks: [{ id: "other", kind: "markdown", text: "text" }] }));
  assert.equal(resolveAction(declaration, { action: "submit", block: "question" },
    validateDocument(document([field]))).action.kind, "response");
});

test("Mermaid source is validated independently from unknown-block fallback", () => {
  assert.doesNotThrow(() => validateDocument({ blocks: [{ id: "flow", kind: "mermaid", source: "flowchart LR\nA --> B" }] }));
  assert.throws(() => validateDocument({ blocks: [{ id: "flow", kind: "mermaid", source: "a".repeat(16385) }] }));
  assert.throws(() => validateDocument({ blocks: [{ id: "flow", kind: "mermaid", source: 1 }] }));
  assert.doesNotThrow(() => validateDocument({ blocks: [{ id: "future", kind: "future", fallback: "Read me" }] }));
});
