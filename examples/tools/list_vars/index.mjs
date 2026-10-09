// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
var HOST_CONTENT_BYTES = 1024 * 1024;
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/bundled/list_vars/index.ts
async function handler(args, context) {
  if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
  try {
    const value = { vars: context.vars.list() };
    if (Buffer.byteLength(JSON.stringify(value)) > context.maxOutputBytes) return errorResult("output_budget_too_small", "variable result exceeds output budget");
    return { isError: false, content: [{ type: "json", value }] };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_error";
    return errorResult(code, error instanceof Error ? error.message : "variable resolution failed");
  }
}
export {
  handler
};
