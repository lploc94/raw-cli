import { spawn } from "node:child_process";
import { VariableError, matchesType, type JsonValue, type VariableProvider } from "./contract.js";
export interface VariableRequest { protocol_version: 1; name: string; params: Readonly<Record<string, JsonValue>> }
export interface VariableResponse { value: JsonValue; observed_at?: string }

export async function runVariableProvider(spec: VariableProvider, request: VariableRequest,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<VariableResponse> {
  const fail = (code: string): never => { throw new VariableError(code, request.name); };
  if (options.signal?.aborted) fail("aborted");
  const input = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(input) > 65537) fail("var_provider_request_too_large");
  const posix = process.platform !== "win32";
  let child;
  try { child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: options.env ?? process.env,
    shell: false, detached: posix, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { return fail("var_provider_spawn"); }
  let failure: string | undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  let killTimer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let escalation: Promise<void> | undefined;
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const signalChild = (signal: NodeJS.Signals) => {
    if (child.pid) try { process.kill(posix ? -child.pid : child.pid, signal); } catch { /* already exited */ }
  };
  const stop = (code: string) => {
    if (failure) return;
    failure = code;
    child.stdin.destroy();
    signalChild("SIGTERM");
    escalation = new Promise<void>(resolve => { killTimer = setTimeout(() => { signalChild("SIGKILL"); resolve(); }, 500); });
    watchdog = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 1500);
  };
  child.on("error", () => stop("var_provider_spawn"));
  child.stdin.on("error", () => stop("var_provider_stdin"));
  child.on("close", (code) => { if (code !== 0 && !failure) failure = "var_provider_exit"; finish(); });
  for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]] as const) {
    stream.on("error", () => stop("var_provider_io"));
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > spec.maxOutputBytes) stop("var_provider_output_too_large");
      else if (keep && !failure) chunks.push(chunk);
    });
  }
  const onAbort = () => stop("aborted");
  const deadline = setTimeout(() => stop("var_provider_timeout"), spec.timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    if (!failure) child.stdin.end(input);
    await completed;
    if (escalation) await escalation;
  } finally {
    clearTimeout(deadline);
    if (watchdog) clearTimeout(watchdog);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
  if (failure) fail(failure);
  let response: unknown;
  try { response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return fail("var_provider_invalid_response"); }
  if (!response || typeof response !== "object" || Array.isArray(response)) fail("var_provider_invalid_response");
  const obj = response as Record<string, unknown>;
  if (Object.keys(obj).some(k => k !== "value" && k !== "observed_at") || !Object.hasOwn(obj, "value") || !matchesType(obj.value, "json")) fail("var_provider_invalid_response");
  if (obj.observed_at !== undefined && (typeof obj.observed_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(obj.observed_at)
    || !Number.isFinite(Date.parse(obj.observed_at))
    || new Date(obj.observed_at).toISOString() !== obj.observed_at.replace(/(?<=:\d{2})Z$/, ".000Z"))) fail("var_provider_invalid_timestamp");
  return obj as unknown as VariableResponse;
}
