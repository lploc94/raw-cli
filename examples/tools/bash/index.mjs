// src/tools/primitives.ts
import { open, mkdir, writeFile, readFile, appendFile } from "fs/promises";
import { createHash } from "crypto";
import { dirname, resolve } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/results.ts
function utf8Prefix(value, limit) {
  let text = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > limit) return { text, bytes, truncated: true };
    text += scalar;
    bytes += size;
  }
  return { text, bytes, truncated: false };
}
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}
function indexedResultFits(results, maxOutputBytes) {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8") <= maxOutputBytes;
}
function indexedResult(results, maxOutputBytes, isError) {
  if (!indexedResultFits(results, maxOutputBytes)) return errorResult("output_budget_too_small", "batch status exceeds output budget");
  return { isError, content: [{ type: "json", value: { results } }] };
}

// src/tools/process.ts
function spawnShell(options, platform = process.platform) {
  return spawn(options.bashPath ?? process.env.RAW_BASH_PATH ?? "bash", ["-c", options.command], {
    cwd: options.cwd,
    ...options.env ? { env: options.env } : {},
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32"
  });
}
function signalShellGroup(child, signal, platform = process.platform) {
  try {
    if (child.pid) process.kill(platform !== "win32" ? -child.pid : child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function runBash(options) {
  if (options.signal?.aborted) return errorResult("aborted", "bash aborted before execution");
  const timeoutMs = options.timeoutMs ?? 12e4;
  const child = spawnShell(options);
  let observedBytes = 0;
  let retainedBytes = 0;
  let truncated = false;
  let saturated = false;
  let timedOut = false;
  let aborted = false;
  let spawnError;
  let stdout = "";
  let stderr = "";
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let killTimer;
  let drainTimer;
  let reapTimer;
  let deadline;
  let resolveCancelled;
  const cancellationWatchdog = new Promise((resolve2) => {
    resolveCancelled = resolve2;
  });
  let escalation;
  const signalGroup = (signal) => signalShellGroup(child, signal);
  const stop = (reason) => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise((resolve2) => {
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve2();
      }, 500);
    });
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveCancelled();
    }, 700);
  };
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  deadline = setTimeout(() => stop("timeout"), timeoutMs);
  const append = (channel, chunk) => {
    observedBytes += chunk.length;
    const text = (channel === "stdout" ? outDecoder : errDecoder).write(chunk);
    if (saturated) return;
    const prefix = utf8Prefix(text, options.maxOutputBytes - retainedBytes);
    retainedBytes += prefix.bytes;
    if (channel === "stdout") stdout += prefix.text;
    else stderr += prefix.text;
    if (prefix.truncated) {
      truncated = true;
      saturated = true;
    }
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  let exited = { code: null, signal: null };
  const exitedPromise = new Promise((resolve2) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve2();
    });
  });
  const closedPromise = new Promise((resolve2) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => resolve2());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed"), cancellationWatchdog.then(() => "watchdog")]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise((resolve2) => {
      reapTimer = setTimeout(resolve2, 1300);
    })]);
    if (reapTimer) clearTimeout(reapTimer);
  }
  if (deadline) clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  if (escalation) await escalation;
  if (drainTimer) clearTimeout(drainTimer);
  for (const [channel, tail] of [["stdout", outDecoder.end()], ["stderr", errDecoder.end()]]) {
    if (!tail) continue;
    if (!saturated) {
      const prefix = utf8Prefix(tail, options.maxOutputBytes - retainedBytes);
      retainedBytes += prefix.bytes;
      if (channel === "stdout") stdout += prefix.text;
      else stderr += prefix.text;
      if (prefix.truncated) truncated = true;
    }
  }
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`);
  const content = [];
  if (stdout) content.push({ type: "text", channel: "stdout", text: stdout });
  if (stderr) content.push({ type: "text", channel: "stderr", text: stderr });
  return {
    isError: aborted || timedOut,
    ...aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {},
    content,
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    truncated: truncated || observedBytes > retainedBytes,
    retainedBytes,
    observedBytes
  };
}

// src/tools/primitives.ts
async function bashTool(args, context) {
  const reserve = (index) => ({
    index,
    status: "error",
    exit_code: 2147483647,
    signal: "SIGKILL",
    timed_out: true,
    truncated: true,
    stdout: "",
    stderr: "",
    observed_bytes: 2147483647,
    error: "x".repeat(80)
  });
  const rows = args.commands.map((_, index) => reserve(index));
  if (!indexedResultFits(rows, context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "bash batch outcomes exceed output budget");
  }
  for (const command of args.commands) if (command.env_refs && Object.keys(command.env_refs).length) {
    if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
    try {
      context.vars.validateEnvRefs(command.env_refs);
    } catch (error) {
      return errorResult("var_env_refs_invalid", error instanceof Error ? error.message : "invalid variable references");
    }
  }
  let stopped = false;
  let stopReason = "prior_timeout";
  for (const [index, command] of args.commands.entries()) {
    if (stopped || context.signal?.aborted) {
      rows[index] = { index, status: "skipped", error: context.signal?.aborted ? "aborted" : stopReason };
      continue;
    }
    const serialized = Buffer.byteLength(JSON.stringify({ results: rows }), "utf8");
    const share = Math.max(0, Math.floor((context.maxOutputBytes - serialized) / (args.commands.length - index)));
    const reservedItemBytes = Buffer.byteLength(JSON.stringify(rows[index]), "utf8");
    let result;
    let bindings;
    try {
      if (command.env_refs && Object.keys(command.env_refs).length) bindings = await context.vars.resolveEnv(command.env_refs, { ...context.signal ? { signal: context.signal } : {} });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_error";
      rows[index] = { index, status: context.signal?.aborted ? "aborted" : "error", error: code };
      stopped = true;
      stopReason = "prior_var_error";
      continue;
    }
    try {
      result = await runBash({
        command: command.command,
        cwd: context.cwd,
        maxOutputBytes: share,
        ...bindings ? { env: { ...process.env, ...bindings } } : {},
        ...command.timeout_ms !== void 0 ? { timeoutMs: command.timeout_ms } : {},
        ...context.signal ? { signal: context.signal } : {},
        ...context.bashPath ? { bashPath: context.bashPath } : {}
      });
    } catch (error) {
      result = errorResult("bash_error", error.message);
    }
    let stdout = result.content.flatMap((item) => item.type === "text" && item.channel === "stdout" ? [item.text] : []).join("");
    let stderr = result.content.flatMap((item) => item.type === "text" && item.channel === "stderr" ? [item.text] : []).join("");
    const status = result.code === "aborted" || context.signal?.aborted ? "aborted" : result.code === "timeout" || result.timedOut ? "timeout" : result.isError ? "error" : "ok";
    const candidate = () => ({
      index,
      status,
      exit_code: result.exitCode ?? null,
      signal: result.signal ?? null,
      timed_out: result.timedOut ?? false,
      truncated: Boolean(result.truncated || stdout !== originalStdout || stderr !== originalStderr),
      stdout,
      stderr,
      observed_bytes: result.observedBytes ?? 0,
      ...status === "error" ? { error: result.code ?? "bash_error" } : {}
    });
    const originalStdout = stdout;
    const originalStderr = stderr;
    const fits = () => {
      const check = [...rows];
      check[index] = candidate();
      const addedBytes = Buffer.byteLength(JSON.stringify(check[index]), "utf8") - reservedItemBytes;
      return addedBytes <= share && indexedResultFits(check, context.maxOutputBytes);
    };
    while (!fits() && (stdout || stderr)) {
      if (Buffer.byteLength(stdout) >= Buffer.byteLength(stderr) && stdout) stdout = utf8Prefix(stdout, Math.floor(Buffer.byteLength(stdout) / 2)).text;
      else stderr = utf8Prefix(stderr, Math.floor(Buffer.byteLength(stderr) / 2)).text;
    }
    rows[index] = fits() ? candidate() : { index, status: "error", error: "result_budget_exhausted" };
    if (status === "aborted" || status === "timeout") stopped = true;
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}

// src/tools/bundled/bash/index.ts
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  const unexpected = Object.keys(args).find((key) => key !== "commands");
  if (unexpected !== void 0) return `unknown bash property ${JSON.stringify(unexpected)}; use {"commands":[{"command":"..."}]}`;
  if (!Array.isArray(args.commands) || args.commands.length < 1 || args.commands.length > 16) return "commands must contain 1 to 16 entries";
  for (const [index, raw] of args.commands.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `commands[${index}] must be an object with a command field, e.g. {"command":"pwd"}; strings are invalid`;
    const command = raw;
    if (Object.keys(command).some((key) => !["command", "timeout_ms", "env_refs"].includes(key))) return `commands[${index}] has an unknown property`;
    if (typeof command.command !== "string" || !command.command) return `commands[${index}].command must be a nonempty string`;
    if (command.env_refs !== void 0) {
      if (!command.env_refs || typeof command.env_refs !== "object" || Array.isArray(command.env_refs) || Object.entries(command.env_refs).some(([key, value2]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value2 !== "string" || !value2)) return `commands[${index}].env_refs must map environment identifiers to variable names`;
    }
    if (command.timeout_ms !== void 0 && (!Number.isSafeInteger(command.timeout_ms) || command.timeout_ms < 1 || command.timeout_ms > 2147483647)) return `commands[${index}].timeout_ms must be a positive integer`;
  }
  return void 0;
}
async function handler(args, context) {
  return bashTool(args, context);
}
export {
  handler,
  validateArgs
};
