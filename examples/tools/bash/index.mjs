// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "fs/promises";
import { dirname, join as join2, parse, relative, resolve, sep } from "path";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/spill.ts
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
var SPILL_MAX_BYTES = 64 * 1024 * 1024;
var SPILL_TOTAL_BYTES = 1024 * 1024 * 1024;
var SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 60 * 1e3;
var PREFIX = "raw-output-";
var directory;
var lastSweep = 0;
var saved = [];
var savedBytes = 0;
var totalLimit = SPILL_TOTAL_BYTES;
var SPILL_PATH_RESERVE = tmpdir().length + 96;
function sweep(root) {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  try {
    const cutoff = Date.now() - SPILL_RETENTION_MS;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const path = join(root, name);
      if (path === directory) continue;
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch {
      }
    }
  } catch {
  }
}
function spillDirectory() {
  const root = tmpdir();
  sweep(root);
  directory ??= mkdtempSync(join(root, PREFIX));
  return directory;
}
function reserve(bytes, keep) {
  savedBytes += bytes;
  keep.bytes += bytes;
  while (savedBytes > totalLimit) {
    const oldest = saved.find((entry) => entry !== keep);
    if (!oldest) break;
    saved.splice(saved.indexOf(oldest), 1);
    savedBytes -= oldest.bytes;
    try {
      rmSync(oldest.path, { force: true });
    } catch {
    }
  }
}
var OutputSpill = class {
  constructor(label) {
    this.label = label;
  }
  label;
  fd;
  failed = false;
  entry;
  path;
  bytes = 0;
  capped = false;
  write(data) {
    if (this.failed || this.capped) return;
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    try {
      if (this.fd === void 0) {
        const path = join(spillDirectory(), `${this.label}-${randomUUID().slice(0, 8)}.log`);
        this.fd = openSync(path, "wx", 384);
        this.path = path;
        this.entry = { path, bytes: 0 };
        saved.push(this.entry);
      }
      const room = SPILL_MAX_BYTES - this.bytes;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      writeSync(this.fd, slice);
      this.bytes += slice.length;
      reserve(slice.length, this.entry);
      if (slice.length < buffer.length) this.capped = true;
    } catch {
      this.failed = true;
      this.close();
      this.path = void 0;
    }
  }
  close() {
    if (this.fd === void 0) return;
    try {
      closeSync(this.fd);
    } catch {
    }
    this.fd = void 0;
  }
};
function spillText(label, text) {
  const spill = new OutputSpill(label);
  spill.write(text);
  spill.close();
  return { ...spill.path ? { path: spill.path } : {}, capped: spill.capped };
}
function savedLabel(path, capped = false) {
  return path && capped ? `${path} (first ${SPILL_MAX_BYTES} bytes only)` : path;
}

// src/tools/results.ts
var DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
var HOST_CONTENT_BYTES = 1024 * 1024;
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
function utf8Suffix(value, limit) {
  const scalars = [...value];
  let bytes = 0;
  let start = scalars.length;
  while (start > 0) {
    const size = Buffer.byteLength(scalars[start - 1]);
    if (bytes + size > limit) break;
    bytes += size;
    start--;
  }
  return { text: scalars.slice(start).join(""), bytes, truncated: start > 0 };
}
function elideMiddle(value, limit, fullOutputPath) {
  const total = Buffer.byteLength(value);
  if (total <= limit) return { text: value, bytes: total, truncated: false };
  return elideParts(value, value, total, limit, fullOutputPath);
}
function elideParts(head, tail, total, limit, fullOutputPath) {
  const marker = (omitted) => `
\u2026[${omitted} bytes omitted${fullOutputPath ? `; full output: ${fullOutputPath}` : ""}]\u2026
`;
  const room = limit - Buffer.byteLength(marker(total));
  if (room <= 0) return { ...utf8Prefix(head, limit), truncated: true };
  const start = utf8Prefix(head, Math.floor(room / 5));
  const end = utf8Suffix(tail, room - start.bytes);
  const text = start.text + marker(total - start.bytes - end.bytes) + end.text;
  return { text, bytes: Buffer.byteLength(text), truncated: true };
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

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

// src/panels/contract.ts
var PANEL_LIMITS = {
  panelsPerTool: 4,
  actionsPerPanel: 8,
  panelsPerSession: 16,
  documentBytes: 64 * 1024,
  blocks: 20,
  items: 200,
  steps: 30,
  checklistDepth: 3,
  updatesPerCall: 200,
  receiptBytes: 1024,
  reminderBytes: 2 * 1024,
  reminderTotalBytes: 8 * 1024,
  markdownBytes: 16 * 1024,
  fallbackBytes: 4 * 1024,
  contextSummaryBytes: 2048
};

// src/tools/write-changes.ts
var MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile, appendFile, stat } from "fs/promises";
import { createHash as createHash2 } from "crypto";
import { dirname as dirname2, resolve as resolve2 } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
var ChannelCapture = class {
  constructor(headCap, tailCap) {
    this.headCap = headCap;
    this.tailCap = tailCap;
  }
  headCap;
  tailCap;
  head = "";
  headBytes = 0;
  tail = [];
  tailBytes = 0;
  total = 0;
  dropped = false;
  push(text) {
    if (!text) return;
    this.total += Buffer.byteLength(text);
    let rest = text;
    if (this.headBytes < this.headCap) {
      const prefix = utf8Prefix(rest, this.headCap - this.headBytes);
      this.head += prefix.text;
      this.headBytes += prefix.bytes;
      rest = rest.slice(prefix.text.length);
      if (!rest) return;
    }
    this.tail.push(rest);
    this.tailBytes += Buffer.byteLength(rest);
    while (this.tail.length > 1 && this.tailBytes - Buffer.byteLength(this.tail[0]) >= this.tailCap) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift());
      this.dropped = true;
    }
  }
  /** Whole text when nothing was dropped and it fits; otherwise start + marker + end within `limit`. */
  text(limit, fullOutputPath) {
    const tail = this.tail.join("");
    if (!this.dropped) return elideMiddle(this.head + tail, limit, fullOutputPath);
    return elideParts(this.head, tail, this.total, limit, fullOutputPath);
  }
};
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
async function runBashDetailed(options) {
  if (options.signal?.aborted) return { result: errorResult("aborted", "bash aborted before execution") };
  const timeoutMs = options.timeoutMs ?? 12e4;
  const child = spawnShell(options);
  let observedBytes = 0;
  let timedOut = false;
  let aborted = false;
  let spawnError;
  const max = Math.max(0, options.maxOutputBytes);
  const captures = { stdout: new ChannelCapture(Math.floor(max / 5), max), stderr: new ChannelCapture(Math.floor(max / 5), max) };
  let pending = [];
  let spill;
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let killTimer;
  let drainTimer;
  let reapTimer;
  let deadline;
  let resolveCancelled;
  const cancellationWatchdog = new Promise((resolve3) => {
    resolveCancelled = resolve3;
  });
  let escalation;
  const signalGroup = (signal) => signalShellGroup(child, signal);
  const stop = (reason) => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise((resolve3) => {
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve3();
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
    try {
      options.onOutput?.(channel, text);
    } catch {
    }
    captures[channel].push(text);
    if (spill) spill.write(chunk);
    else {
      pending.push(chunk);
      if (observedBytes > max) {
        spill = new OutputSpill("bash");
        for (const buffered of pending) spill.write(buffered);
        pending = [];
      }
    }
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  let exited = { code: null, signal: null };
  const exitedPromise = new Promise((resolve3) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve3();
    });
  });
  const closedPromise = new Promise((resolve3) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => resolve3());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed"), cancellationWatchdog.then(() => "watchdog")]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise((resolve3) => {
      reapTimer = setTimeout(resolve3, 1300);
    })]);
    if (reapTimer) clearTimeout(reapTimer);
  }
  if (deadline) clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  if (escalation) await escalation;
  if (drainTimer) clearTimeout(drainTimer);
  for (const [channel, tail] of [["stdout", outDecoder.end()], ["stderr", errDecoder.end()]]) {
    if (!tail) continue;
    try {
      options.onOutput?.(channel, tail);
    } catch {
    }
    captures[channel].push(tail);
  }
  spill?.close();
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return { result: errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`) };
  const render = (limit, fullOutputPath = savedLabel(spill?.path, spill?.capped)) => {
    const small = captures.stdout.total <= captures.stderr.total ? "stdout" : "stderr";
    const smallBudget = Math.min(captures[small].total, Math.floor(limit / 2));
    const largeBudget = limit - smallBudget;
    const out = captures.stdout.text(small === "stdout" ? smallBudget : largeBudget, fullOutputPath);
    const err = captures.stderr.text(small === "stderr" ? smallBudget : largeBudget, fullOutputPath);
    return { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  };
  const { stdout, stderr, truncated } = render(max);
  const retainedBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  const content = [];
  if (stdout) content.push({ type: "text", channel: "stdout", text: stdout });
  if (stderr) content.push({ type: "text", channel: "stderr", text: stderr });
  return { render, result: {
    isError: aborted || timedOut,
    ...aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {},
    content,
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    truncated,
    retainedBytes,
    observedBytes,
    ...truncated && spill?.path ? { fullOutputPath: spill.path, ...spill.capped ? { fullOutputCapped: true } : {} } : {}
  } };
}

// src/tools/primitives.ts
async function bashTool(args, context) {
  const reserve2 = (index) => ({
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
  const rows = args.commands.map((_, index) => reserve2(index));
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
    let render;
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
    let activity;
    try {
      activity = context.commandActivity?.begin(command.command, context.cwd);
    } catch {
    }
    try {
      ({ result, render } = await runBashDetailed({
        command: command.command,
        cwd: context.cwd,
        maxOutputBytes: share,
        ...activity ? { onOutput: activity.output } : {},
        ...bindings ? { env: { ...process.env, ...bindings } } : {},
        ...command.timeout_ms !== void 0 ? { timeoutMs: command.timeout_ms } : {},
        ...context.signal ? { signal: context.signal } : {},
        ...context.bashPath ? { bashPath: context.bashPath } : {}
      }));
    } catch (error) {
      result = errorResult("bash_error", error.message);
    }
    try {
      activity?.finish(result);
    } catch {
    }
    let stdout = result.content.flatMap((item) => item.type === "text" && item.channel === "stdout" ? [item.text] : []).join("");
    let stderr = result.content.flatMap((item) => item.type === "text" && item.channel === "stderr" ? [item.text] : []).join("");
    const status = result.code === "aborted" || context.signal?.aborted ? "aborted" : result.code === "timeout" || result.timedOut ? "timeout" : result.isError ? "error" : "ok";
    let fullOutput = result.fullOutputPath;
    let fullOutputCapped = result.fullOutputCapped === true;
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
      ...status === "error" ? { error: result.code ?? "bash_error" } : {},
      ...fullOutput ? { full_output: fullOutput } : {}
    });
    const originalStdout = stdout;
    const originalStderr = stderr;
    const fits = () => {
      const check = [...rows];
      check[index] = candidate();
      const addedBytes = Buffer.byteLength(JSON.stringify(check[index]), "utf8") - reservedItemBytes;
      return addedBytes <= share && indexedResultFits(check, context.maxOutputBytes);
    };
    if (!fits() && !fullOutput) {
      ({ path: fullOutput, capped: fullOutputCapped } = spillText("bash", `${originalStdout}${originalStderr ? `${originalStdout ? "\n" : ""}[stderr]
${originalStderr}` : ""}`));
    }
    for (let limit = Buffer.byteLength(stdout) + Buffer.byteLength(stderr); !fits() && limit > 0; ) {
      limit = Math.floor(limit * 3 / 4);
      const saved2 = savedLabel(fullOutput, fullOutputCapped);
      if (render) ({ stdout, stderr } = render(limit, saved2));
      else {
        stdout = elideMiddle(stdout, Math.floor(limit / 2), saved2).text;
        stderr = elideMiddle(stderr, limit - Buffer.byteLength(stdout), saved2).text;
      }
    }
    if (!fits() && fullOutput) fullOutput = void 0;
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
