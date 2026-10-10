// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/spill.ts
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
var SPILL_MAX_BYTES = 64 * 1024 * 1024;
var SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var SPILL_PATH_RESERVE = tmpdir().length + 64;

// src/tools/results.ts
var DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
var HOST_CONTENT_BYTES = 1024 * 1024;
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/bundled/load_skill/index.ts
async function handler(args, context) {
  const skill = context.skills?.find((item) => item.name === args.name);
  if (!skill) return { isError: true, code: "unknown_skill", content: [{ type: "text", text: "skill is not selected" }] };
  if (Buffer.byteLength(skill.markdown) > context.maxOutputBytes) return errorResult("output_budget_too_small", "skill body exceeds output budget");
  return { isError: false, content: [{ type: "text", text: skill.markdown }] };
}
export {
  handler
};
