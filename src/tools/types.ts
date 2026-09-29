export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export interface ToolContentText {
  type: "text";
  text: string;
  channel?: "stdout" | "stderr";
}

export interface ToolContentJson {
  type: "json";
  value: unknown;
}

export interface ToolContentImage {
  type: "image";
  mimeType: "image/png" | "image/jpeg";
  data: string;
  path?: string;
  byteSize?: number;
}

export type ToolContent = ToolContentText | ToolContentJson | ToolContentImage;

/**
 * A raw.panel/1 update returned by a tool handler (docs/panels-design.md §8.1). It is host-only data:
 * `ToolRegistry.dispatch` removes it before hooks, caps, providers and history, so it is not part of `ToolContent`.
 */
export interface ToolContentPanel {
  type: "panel";
  panel: string;
  op: "replace" | "patch" | "close";
  document?: unknown;
  patches?: unknown;
  base_revision?: unknown;
}

export type ToolHandlerContent = ToolContent | ToolContentPanel;

export interface ToolResult {
  isError: boolean;
  content: ToolContent[];
  truncated?: boolean;
  retainedBytes?: number;
  observedBytes?: number;
  code?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}

/** What a handler (or an MCP/ACP conversion) may return: a ToolResult that can also carry panel blocks. */
export type ToolHandlerResult = Omit<ToolResult, "content"> & { content: ToolHandlerContent[] };
