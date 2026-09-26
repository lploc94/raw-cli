import { parseDocument } from "yaml";

export interface ParsedSkillMarkdown { name: string; description: string; markdown: string; version?: string }

export function parseSkillMarkdown(source: string, folder: string, label = "SKILL.md"): ParsedSkillMarkdown {
  if (!source.startsWith("---\n")) throw new Error(`${label}: missing YAML frontmatter`);
  const close = source.indexOf("\n---\n", 4);
  if (close < 0) throw new Error(`${label}: unclosed YAML frontmatter`);
  const header = source.slice(4, close);
  const document = parseDocument(header, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  const value: unknown = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: invalid frontmatter`);
  const data = value as Record<string, unknown>;
  const name = data.name;
  const description = data.description;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`${label}: invalid skill name`);
  }
  if (name !== folder.replaceAll("_", "-")) throw new Error(`${label}: skill name does not match folder ${folder}`);
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error(`${label}: invalid skill description`);
  }
  if (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata)
    || Object.values(data.metadata).some((item) => typeof item !== "string"))) {
    throw new Error(`${label}: invalid skill metadata`);
  }
  if (data.compatibility !== undefined && (typeof data.compatibility !== "string" || data.compatibility.length > 500)) {
    throw new Error(`${label}: invalid skill compatibility`);
  }
  if (data.license !== undefined && typeof data.license !== "string") throw new Error(`${label}: invalid skill license`);
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") {
    throw new Error(`${label}: invalid skill allowed-tools`);
  }
  const metadata = data.metadata as Record<string, string> | undefined;
  const version = metadata?.version;
  return { name, description, markdown: source.slice(close + 5), ...(version ? { version } : {}) };
}
