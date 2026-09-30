import { ToolRegistry, type ToolPolicyRule, type ToolRegistration } from "../../src/tools/registry.js";
import readManifest from "../../src/tools/bundled/read_file/tool.json" with { type: "json" };
import writeManifest from "../../src/tools/bundled/write_file/tool.json" with { type: "json" };
import bashManifest from "../../src/tools/bundled/bash/tool.json" with { type: "json" };
import imageManifest from "../../src/tools/bundled/view_image/tool.json" with { type: "json" };
import { handler as read, validateArgs as validateRead } from "../../src/tools/bundled/read_file/index.js";
import { handler as write, validateArgs as validateWrite, describeEffects as writeEffects } from "../../src/tools/bundled/write_file/index.js";
import { handler as bash, validateArgs as validateBash } from "../../src/tools/bundled/bash/index.js";
import { handler as image, validateArgs as validateImage } from "../../src/tools/bundled/view_image/index.js";

export { ToolRegistry, BUILTIN_TOOL_DEFINITIONS } from "../../src/tools/registry.js";

export function createTestToolRegistry(rules: readonly ToolPolicyRule[] = [], vision = false): ToolRegistry {
  const registry = new ToolRegistry(rules);
  const entries: Array<[{ name: string; id: string; description: string; input_schema: unknown },
    ToolRegistration["handler"], NonNullable<ToolRegistration["validateArgs"]>]> =
    [[readManifest, read, validateRead], [writeManifest, write, validateWrite],
      [bashManifest, bash, validateBash]];
  if (vision) entries.push([imageManifest, image, validateImage]);
  for (const [manifest, handler, validateArgs] of entries) registry.register({
    name: manifest.name, canonicalName: `builtin/${manifest.id}`,
    description: manifest.description, inputSchema: manifest.input_schema as ToolRegistration["inputSchema"],
    ...(manifest.id === "write_file" ? { conditionSources: ["effects"], effectsSchema: writeManifest.effects_schema,
      describeEffects: writeEffects } : { conditionSources: ["arguments"] }),
    handler, validateArgs,
  });
  return registry;
}
