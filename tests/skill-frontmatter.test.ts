import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillMarkdown } from "../src/skills/frontmatter.js";

test("Agent Skills frontmatter is the only catalog metadata", () => {
  const parsed = parseSkillMarkdown("---\nname: code-review\ndescription: Review code for correctness. Use for pull requests.\n---\n# Review\nRead changes.\n", "code-review");
  assert.equal(parsed.name, "code-review");
  assert.match(parsed.description, /pull requests/);
  assert.equal(parsed.markdown, "# Review\nRead changes.\n");
});

test("duplicate keys, bad names and missing metadata fail with local diagnostics", () => {
  assert.throws(() => parseSkillMarkdown("---\nname: code-review\nname: second\ndescription: Review\n---\n# Body", "code-review"), /duplicate|SKILL.md/i);
  assert.throws(() => parseSkillMarkdown("---\nname: Bad_Name\ndescription: Review\n---\n# Body", "code-review"), /name/i);
  assert.throws(() => parseSkillMarkdown("# Body", "code-review"), /frontmatter|SKILL.md/i);
});
