import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { loadVariableConfig } from "../src/config.js";
import { createVariableResolver } from "../src/vars/resolver.js";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";

test("documented JSON blocks parse and English setup bodies stay usable within default cap", () => {
  const guide = readFileSync("docs/vars.md", "utf8");
  assert.match(guide, /protocol_version/);
  for (const name of ["configure_raw", "create_tool", "create_agent", "create_skill", "add_mcp"]) {
    const body = readFileSync(`src/skills/bundled/${name}/SKILL.md`, "utf8");
    assert.ok(Buffer.byteLength(parseSkillMarkdown(body, name).markdown) <= 8192, name);
    assert.match(body, /vars/);
    for (const block of body.matchAll(/```json\n([\s\S]*?)\n```/g)) JSON.parse(block[1]!);
    assert.equal(body, readFileSync(`examples/skills/${name}/SKILL.md`, "utf8"));
  }
  for (const block of guide.matchAll(/```json\n([\s\S]*?)\n```/g)) JSON.parse(block[1]!);
});
test("copied provider example resolves from its config location in an unrelated cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-provider-example-"));
  cpSync("examples/providers/host-info", root, { recursive: true });
  const config = loadVariableConfig({ configPath: join(root, "raw.json"), cwd: resolve("/"), env: {} });
  const vars = createVariableResolver({ config });
  assert.equal((await vars.read("hostname")).value, hostname());
  assert.equal((await vars.read("hostname")).cached, true);
});

test("create_tool provider script runs using the documented registration protocol", async () => {
  const body=readFileSync("src/skills/bundled/create_tool/SKILL.md","utf8");
  const script=body.split("<!-- example:var-provider -->")[1]!.match(/```js\n([\s\S]*?)\n```/)![1]!;
  const dir=mkdtempSync(join(tmpdir(),"raw-skill-provider-"));writeFileSync(join(dir,"host.mjs"),script);
  const path=join(dir,"raw.json");writeFileSync(path,JSON.stringify({default_agent:"raw",models:{m:{provider:"ollama",method:"openai-chat-completions",model_id:"fixture"}},
    var_providers:{host:{command:process.execPath,args:["host.mjs"]}},vars:{host:{description:"Host name",access:"read",type:"string",source:{kind:"provider",name:"host"}}},
    agents:{raw:{model:"m",tools:{use:[]},vars:["host"]}}}));
  assert.equal((await createVariableResolver({config:loadVariableConfig({configPath:path})}).read("host")).value,hostname());
});
