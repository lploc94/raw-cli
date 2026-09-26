import { marked } from "marked";
import { textWidth, wrapStyled } from "./layout.js";
import { highlightCode } from "./highlight.js";
import { paint } from "./theme.js";
import type { TerminalCapabilities, UiOptions } from "./options.js";
import { safeTerminalText } from "./safe.js";

type Token = Record<string, unknown>;
const LIMIT_BYTES = 32 * 1024;

const safe = safeTerminalText;

function inline(tokens: unknown, ui: UiOptions, caps: TerminalCapabilities): string {
  if (!Array.isArray(tokens)) return "";
  return (tokens as Token[]).map((token) => {
    const type = token.type;
    const body = typeof token.text === "string" ? safe(token.text) : "";
    if (type === "text" || type === "escape") return body;
    if (type === "codespan") return paint("accent", `\`${body}\``, ui, caps);
    if (type === "strong") return caps.ansi ? `\x1b[1m${inline(token.tokens, ui, caps)}\x1b[22m` : `**${inline(token.tokens, ui, caps)}**`;
    if (type === "em") return caps.ansi ? `\x1b[3m${inline(token.tokens, ui, caps)}\x1b[23m` : `*${inline(token.tokens, ui, caps)}*`;
    if (type === "del") return `~${inline(token.tokens, ui, caps)}~`;
    if (type === "link") {
      const label = inline(token.tokens, ui, caps) || body;
      const href = typeof token.href === "string" ? safe(token.href) : "";
      return `${label}${href ? ` (${paint("path", href, ui, caps)})` : ""}`;
    }
    if (type === "image") return `[image: ${body}]`;
    if (type === "br") return "\n";
    return typeof token.raw === "string" ? safe(token.raw) : body;
  }).join("");
}

function textToken(token: Token, ui: UiOptions, caps: TerminalCapabilities): string {
  return token.tokens ? inline(token.tokens, ui, caps) : safe(String(token.text ?? ""));
}

function renderTable(token: Token, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  const header = Array.isArray(token.header) ? token.header as Token[] : [];
  const rows = Array.isArray(token.rows) ? token.rows as Token[][] : [];
  const plainCaps = { ...caps, ansi: false, cursor: false };
  const plainHeaders = header.map((cell) => textToken(cell, ui, plainCaps));
  const plainRows = rows.map((row) => row.map((cell) => textToken(cell, ui, plainCaps)));
  const columns = header.map((_item, index) => Math.max(textWidth(plainHeaders[index] ?? ""),
    ...plainRows.map((row) => textWidth(row[index] ?? ""))));
  const required = columns.reduce((sum, size) => sum + size, 0) + Math.max(0, columns.length - 1) * 3;
  if (required > width || !columns.length) return plainRows.map((row) => row.map((value, index) =>
    `${paint("path", plainHeaders[index] ?? `Column ${index + 1}`, ui, caps)}: ${value}`).join("\n")).join("\n") + "\n";
  const format = (values: string[]) => values.map((value, index) => value + " ".repeat(Math.max(0, columns[index]! - textWidth(value)))).join(" | ");
  return `${paint("accent", format(plainHeaders), ui, caps)}\n${columns.map((size) => "─".repeat(size)).join("─┼─")}\n`
    + plainRows.map((row) => format(row)).join("\n") + "\n";
}

function renderTokens(tokens: Token[], ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  return tokens.map((token) => {
    const type = token.type;
    if (type === "space") return "\n";
    if (type === "heading") return `${paint("accent", textToken(token, ui, caps), ui, caps)}\n`;
    if (type === "paragraph" || type === "text") return wrapStyled(textToken(token, ui, caps), width).join("\n") + "\n";
    if (type === "code") {
      const source = safe(String(token.text ?? ""));
      return `${highlightCode(source, typeof token.lang === "string" ? token.lang : undefined, ui, caps)}\n`;
    }
    if (type === "list") {
      const items = Array.isArray(token.items) ? token.items as Token[] : [];
      const ordered = token.ordered === true;
      const start = typeof token.start === "number" ? token.start : 1;
      return items.map((item, index) => {
        const prefix = ordered ? `${start + index}. ` : "- ";
        const checked = item.task === true ? (item.checked ? "[x] " : "[ ] ") : "";
        const body = textToken(item, ui, caps).replace(/\n+$/, "");
        return wrapStyled(prefix + checked + body, width).join("\n");
      }).join("\n") + "\n";
    }
    if (type === "blockquote") {
      const source = Array.isArray(token.tokens) ? renderTokens(token.tokens as Token[], ui, caps, width - 2).trimEnd() : safe(String(token.text ?? ""));
      return source.split("\n").map((line) => `${paint("muted", "> ", ui, caps)}${line}`).join("\n") + "\n";
    }
    if (type === "table") return renderTable(token, ui, caps, width);
    if (type === "hr") return `${"─".repeat(Math.min(Math.max(3, width), 60))}\n`;
    if (type === "html") return safe(String(token.raw ?? token.text ?? "")) + "\n";
    return safe(String(token.raw ?? token.text ?? "")) + "\n";
  }).join("");
}

export function renderMarkdown(source: string, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  if (!source) return "";
  try { return renderTokens(marked.lexer(source, { gfm: true, breaks: false }) as unknown as Token[], ui, caps, Math.max(8, width)); }
  catch { return safe(source); }
}

export interface MarkdownFrame { committed: string; tail: string }
export class MarkdownStream {
  private pending = "";
  private fallback = false;
  private fallbackLast = "";
  private peak = 0;
  constructor(private readonly ui: UiOptions, private readonly caps: TerminalCapabilities, private readonly width: number) {}
  get maxPendingBytes(): number { return this.peak; }

  push(chunk: string): MarkdownFrame {
    if (this.fallback) {
      const boundary = (this.fallbackLast + chunk).indexOf("\n\n");
      if (boundary < 0) {
        this.fallbackLast = chunk.slice(-1) || this.fallbackLast;
        return { committed: safe(chunk), tail: "" };
      }
      const before = Math.max(0, boundary + 2 - this.fallbackLast.length);
      const committed = safe(chunk.slice(0, before));
      this.fallback = false;
      this.fallbackLast = "";
      const next = chunk.slice(before);
      const frame = next ? this.push(next) : { committed: "", tail: "" };
      return { committed: committed + frame.committed, tail: frame.tail };
    }
    this.pending += chunk;
    let committed = "";
    while (true) {
      const boundary = this.pending.indexOf("\n\n");
      if (boundary < 0) break;
      const block = this.pending.slice(0, boundary + 2);
      committed += this.fallback ? safe(block) : renderMarkdown(block, this.ui, this.caps, this.width);
      this.pending = this.pending.slice(boundary + 2);
      this.fallback = false;
    }
    if (Buffer.byteLength(this.pending, "utf8") > LIMIT_BYTES) {
      committed += safe(this.pending);
      this.fallbackLast = this.pending.slice(-1);
      this.pending = "";
      this.fallback = true;
      return { committed, tail: "" };
    }
    this.peak = Math.max(this.peak, Buffer.byteLength(this.pending, "utf8"));
    const tail = renderMarkdown(this.pending, this.ui, this.caps, this.width);
    const logical = tail.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    const rows = logical.reduce((sum, line, index) => sum + (index === logical.length - 1 && line === "" ? 0
      : Math.max(1, Math.ceil(textWidth(line) / Math.max(1, this.width)))), 0);
    if (rows > 20) {
      committed += safe(this.pending);
      this.fallbackLast = this.pending.slice(-1);
      this.pending = "";
      this.fallback = true;
      return { committed, tail: "" };
    }
    return { committed, tail };
  }

  flush(): string {
    const result = this.fallback ? safe(this.pending) : renderMarkdown(this.pending, this.ui, this.caps, this.width);
    this.pending = "";
    this.fallback = false;
    this.fallbackLast = "";
    return result;
  }
}
