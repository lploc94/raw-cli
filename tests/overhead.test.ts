import assert from "node:assert/strict";
import { test } from "node:test";
import { countOverhead } from "../scripts/overhead.mjs";
import { createTestToolRegistry } from "./fixtures/registry.js";

test("production prompt is minimal and built-in schema overhead is measurable", () => {
  const report = countOverhead();
  assert.equal(report.definitions.length, 3);
  assert.ok(report.promptTokens <= 50);
  assert.ok(Number.isSafeInteger(report.combinedTokens) && report.combinedTokens >= report.promptTokens);
  assert.equal(JSON.parse(report.canonical).tools.length, 3);
});

test("model-facing tool definitions explain the required workflows", () => {
  const tools = Object.fromEntries(countOverhead().definitions.map((definition) => [definition.name, definition]));
  assert.match(tools.read_file!.description, /next_line/);
  assert.match(tools.read_file!.description, /sha256/);
  assert.match(tools.write_file!.description, /expected_sha256/);
  assert.match(tools.write_file!.description, /replace_text/);
  assert.match(tools.write_file!.description, /replace_lines/);
  assert.match(tools.bash!.description, /exit_code/);
  assert.match(tools.bash!.description, /timeout/);
  assert.match(tools.bash!.description, /\{"commands":\[\{"command":"pwd"\},\{"command":"ls -la"\}\]\}/);
  assert.match(tools.bash!.description, /objects, never strings/);
  for (const tool of Object.values(tools)) {
    const root = tool!.inputSchema as Record<string, unknown>;
    const properties = root.properties as Record<string, Record<string, unknown>>;
    for (const [name, property] of Object.entries(properties)) {
      assert.equal(typeof property.description, "string", `${tool!.name}.${name} needs a description`);
      const itemProperties = (property.items as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {};
      for (const [field, schema] of Object.entries(itemProperties)) {
        assert.equal(typeof schema.description, "string", `${tool!.name}.${name}[].${field} needs a description`);
      }
    }
  }
  const image = createTestToolRegistry([], true).definitions().find((definition) => definition.name === "view_image");
  assert.match(image!.description, /native image block/);
  assert.equal(typeof (image!.inputSchema.properties!.path as { description?: string }).description, "string");
});
