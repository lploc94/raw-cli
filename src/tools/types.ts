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
}

export type ToolContent = ToolContentText | ToolContentJson | ToolContentImage;

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
