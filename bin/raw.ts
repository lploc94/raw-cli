import { initializeConfig } from "../src/management/config.js";
import { createVariableResolver } from "../src/vars/resolver.js";
import { configFilePath, loadConfig, loadVariableConfigAsync, parseCliArgs, readConfigDocument, readSessionRetentionDays, redact } from "../src/config.js";
import { createAcpServer } from "../src/acp/methods.js";
import { serveAcpStdio, serveAcpWebSocket } from "../src/acp/transport.js";
import { parseUiDocument, resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import { openSessionStore } from "../src/sessions/store.js";
import { runSessionMaintenance } from "../src/sessions/maintenance.js";
import { runPackageCli } from "../src/packages/cli.js";

const version = "0.1.0";
class InputError extends Error {}

function input<T>(read: () => T): T {
  try { return read(); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : String(error)); }
}

async function inputAsync<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : String(error)); }
}

function help(): string {
  return `raw-cli ${version}
Usage: raw [options] [task]
       raw dashboard [--port PORT] [--no-open] [--config PATH] [--agent NAME]
       raw vars list|get NAME
       raw config init|list
       raw package list|inspect|validate|pack|export|install|update|remove|link|fork
       raw agent add NAME --from pkg/ALIAS/agents/EXPORT --model MODEL_ALIAS
       raw sessions [--all] [--before CURSOR]
       raw sessions show ID [--before CURSOR]
       raw sessions panels ID [PANEL] [--all] [--json]
       raw sessions delete ID|stats
       raw --acp --stdio
       raw --acp --ws --host 127.0.0.1 --port 8765

Options:
  --agent NAME               Select a configured agent
  --config PATH              Use one alternate config file
  --system-prompt TEXT       Replace the system prompt literally
  --max-steps N              Maximum inference requests (default 10000)
  --max-output-bytes N       Model-facing tool result cap (default 8192)
  --request-timeout-ms N     Inference/MCP deadline (default 120000)
  --display MODE             compact | normal | verbose
  --reasoning MODE           hidden | summary | full
  --color MODE               auto | always | never
  --icons MODE               auto | unicode | ascii
  --theme NAME               terminal | dark | light
  --interactive              Start a terminal REPL
  --continue                 Resume latest session in current workspace
  --resume ID                Resume a selected session in its stored cwd
  -y, --auto-approve         Compatibility alias (tools run automatically)
  --help, --version          Show help or version

Session options: --all (list all workspaces), --before CURSOR (older page)

REPL: /compact, /clear, /stats, /exit
Config: models define access paths; agents select a model, prompt, tools and policy.
Packages: raw package install PATH --as ALIAS; raw package update ALIAS --from PATH.
Vision: a model with vision=true may select builtin/view_image.
Skills: agents may select packaged, global, or config-adjacent skills and both skill tools.
Setup: config init selects seven packaged setup skills for the raw agent.
Examples: installed examples/tools/ can be forked; examples/agents/project-helper/ is copyable.
Compact: agent compact.trigger_tokens enables automatic compaction.
Exit: 0 complete, 1 runtime error, 2 invalid input, 3 max steps, 130 cancelled
`;
}

async function run(): Promise<void> {
  if (process.argv[2] === "dashboard") {
    const { parseDashboardArgs, runDashboardCli } = await import("../src/dashboard/cli.js");
    await runDashboardCli(input(() => parseDashboardArgs(process.argv.slice(3)))); return;
  }
  if (process.argv[2] === "package" || process.argv[2] === "agent") {
    await inputAsync(() => runPackageCli(process.argv.slice(2)));
    return;
  }
  const parsed = input(() => parseCliArgs(process.argv.slice(2)));
  if (parsed.command === "help") { process.stdout.write(help()); return; }
  if (parsed.command === "version") { process.stdout.write(`${version}\n`); return; }
  if (parsed.command === "config-init") {
    const path = input(() => configFilePath({ flags: parsed.flags }));
    await inputAsync(() => initializeConfig({ flags: parsed.flags }));
    process.stdout.write(`Created ${path}\n`);
    return;
  }
  if (parsed.command === "vars-list" || parsed.command === "vars-get") {
    const config = await inputAsync(() => loadVariableConfigAsync({ flags: parsed.flags }));
    const vars = createVariableResolver({ config });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const result = parsed.command === "vars-list" ? { vars: vars.list() } : await vars.read(parsed.variableName!, { signal: controller.signal });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      process.exitCode = 130;
      process.stderr.write("raw: variable resolution cancelled\n");
    } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    return;
  }
  if (parsed.command === "config-list") {
    const document = input(() => readConfigDocument({ flags: parsed.flags }));
    const agents = document.data.agents;
    const models = document.data.models;
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
      process.stdout.write("No configured agents.\n");
      return;
    }
    for (const [name, raw] of Object.entries(agents)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const data = raw as Record<string, unknown>;
      let effective: Awaited<ReturnType<typeof loadConfig>> | undefined;
      let bindingError: string | undefined;
      if (typeof data.from === "string") {
        try { effective = await loadConfig({ flags: { ...parsed.flags, agent: name }, requireModel: false }); }
        catch (error) { bindingError = error instanceof Error ? error.message : String(error); }
      }
      const alias = String(data.model ?? "?");
      const model = models && typeof models === "object" && !Array.isArray(models)
        ? (models as Record<string, unknown>)[alias] : undefined;
      const spec = model && typeof model === "object" && !Array.isArray(model) ? model as Record<string, unknown> : {};
      const endpoint = typeof spec.base_url === "string" ? redact(spec.base_url) : "default endpoint";
      const selectedTools = effective?.toolIds ?? (data.tools && typeof data.tools === "object" && !Array.isArray(data.tools)
        ? (data.tools as { use?: string[] }).use ?? [] : []);
      const selectedSkills = effective?.skillIds ?? (data.skills && typeof data.skills === "object" && !Array.isArray(data.skills)
        ? (data.skills as { use?: string[] }).use ?? [] : []);
      const selectedVars = effective?.variableConfig.variables.map((item) => item.name)
        ?? (Array.isArray(data.vars) ? data.vars : []);
      const policy = effective?.toolRules ?? (data.tools && typeof data.tools === "object" && !Array.isArray(data.tools)
        ? (data.tools as { rules?: Array<{ match: string; effect: string; when?: { any: string; regex: string } }> }).rules ?? [] : []);
      const rules = policy.map((rule) => `${rule.effect}:${rule.match}${rule.when ? `:${JSON.stringify(rule.when)}` : ""}`).join(",");
      const compact = data.compact && typeof data.compact === "object" && !Array.isArray(data.compact)
        ? data.compact as Record<string, unknown> : {};
      process.stdout.write(`${name}\t${alias}\t${String(spec.model_id ?? "?")}\t${String(spec.provider ?? "?")}\t${String(spec.method ?? "?")}\t${endpoint}`
        + `\tvision=${spec.vision === true}\ttools=${selectedTools.join(",") || "none"}\tskills=${selectedSkills.join(",") || "none"}\trules=${rules || "default-allow"}`
        + `\tvars=${selectedVars.join(",") || "none"}`
        + `\ttrigger=${effective?.compact.triggerTokens ?? compact.trigger_tokens ?? "manual"}`
        + `${typeof data.from === "string" ? `\tfrom=${data.from}` : ""}`
        + `${bindingError ? `\terror=${redact(bindingError)}` : ""}\n`);
    }
    return;
  }
  if (parsed.command === "acp") {
    const runtime = await inputAsync(() => loadConfig({ flags: parsed.flags }));
    if (parsed.acpTransport !== "ws") {
      await serveAcpStdio(createAcpServer({ runtime }));
      return;
    }
    const listener = await serveAcpWebSocket({ host: parsed.flags.host ?? "127.0.0.1", port: parsed.flags.port ?? 8765,
      serverFactory: () => createAcpServer({ runtime }) });
    process.stderr.write(`raw: ACP WebSocket listening on 127.0.0.1:${listener.port}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => { void listener.close().then(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const store = input(() => openSessionStore());
  try {
    try { runSessionMaintenance(store, { sweepOrphans: false, reclaim: false }); }
    catch { process.stderr.write("raw: session maintenance deferred\n"); }
    if (parsed.command.startsWith("sessions-")) {
      if (parsed.command === "sessions-list") {
        const page = input(() => store.listSessions({ ...(parsed.flags.allSessions ? {} : { cwd: process.cwd() }),
          ...(parsed.flags.before ? { before: parsed.flags.before } : {}) }));
        const retention = input(() => readSessionRetentionDays());
        for (const item of page.items) {
          process.stdout.write(`${item.id}\t${item.title}\t${item.cwd}\t${item.agentName ?? "?"}/${item.modelId ?? "?"}`
            + `\t${new Date(item.updatedAt).toISOString()}\t${new Date(item.updatedAt + retention * 86_400_000).toISOString()}\n`);
        }
        if (page.nextCursor) process.stdout.write(`next: ${page.nextCursor}\n`);
      } else if (parsed.command === "sessions-show") {
        const { renderTerminalHistory } = await import("../src/terminal/history.js");
        const ui = input(() => resolveUiOptions(parseUiDocument(readConfigDocument({ flags: parsed.flags }).data.ui), parsed.flags));
        const caps = terminalCapabilities(Boolean(process.stdout.isTTY), process.env, ui);
        const page = input(() => store.getSessionHistory({ sessionId: parsed.sessionId!,
          ...(parsed.flags.before ? { before: parsed.flags.before } : {}) }));
        for (const item of page.items) process.stdout.write(renderTerminalHistory(item, ui, caps, process.stdout.columns || 80));
        if (page.nextCursor) process.stdout.write(`next: ${page.nextCursor}\n`);
      } else if (parsed.command === "sessions-panels") {
        if (!store.getSession(parsed.sessionId!)) throw new InputError(store.missingSessionMessage());
        const { selectPanels, renderPanelsText, panelTitle } = await import("../src/panels/render.js");
        const found = selectPanels(store.listSessionPanels(parsed.sessionId!), { ...(parsed.flags.allSessions ? { all: true } : {}), ...(parsed.panelId ? { id: parsed.panelId } : {}) });
        if (!found) throw new InputError(`unknown panel ${parsed.panelId}`);
        if (parsed.flags.json) {
          process.stdout.write(`${JSON.stringify(found.map((panel) => ({ panel: panel.panelId, owner: panel.owner, title: panelTitle(panel), revision: panel.revision,
            updatedAt: panel.updatedAt, closed: panel.closed, document: panel.document })))}\n`);
        } else {
          const { safeTerminalText } = await import("../src/terminal/safe.js");
          process.stdout.write(found.length ? `${safeTerminalText(renderPanelsText(found.map((panel) => ({ title: panelTitle(panel), document: panel.document, closed: panel.closed }))))}\n` : "No open panels.\n");
        }
      } else if (parsed.command === "sessions-delete") {
        if (!store.getSession(parsed.sessionId!)) throw new InputError(store.missingSessionMessage());
        input(() => store.deleteSession(parsed.sessionId!));
        process.stdout.write(`Deleted ${parsed.sessionId}\n`);
      } else process.stdout.write(`${JSON.stringify(store.storageStats())}\n`);
      return;
    }
    const selected = input(() => parsed.flags.continue
      ? store.listSessions({ cwd: process.cwd(), limit: 1 }).items[0]
      : parsed.flags.resumeId ? store.getSession(parsed.flags.resumeId) : undefined);
    if ((parsed.flags.continue || parsed.flags.resumeId) && !selected) throw new InputError(store.missingSessionMessage());
    let runtime;
    if (selected) {
      const savedConfigPath = selected.configPath;
      const savedAgentName = selected.agentName;
      if (!savedConfigPath || !savedAgentName) throw new InputError("saved session has no config/agent identity");
      runtime = await inputAsync(() => loadConfig({ cwd: selected.cwd, flags: {
        ...parsed.flags, configPath: parsed.flags.configPath ? configFilePath({ flags: parsed.flags }) : savedConfigPath,
        ...(!parsed.flags.agent && !parsed.flags.configPath ? { agent: savedAgentName } : {}),
      }, requireModel: true }));
      process.stderr.write(`raw: resuming in ${selected.cwd}\n`);
    } else runtime = await inputAsync(() => loadConfig({ flags: parsed.flags, requireModel: true }));
    const { runCli } = await import("../src/cli.js");
    process.exitCode = await runCli(runtime, parsed.command === "task" ? parsed.task : undefined, store, selected);
  } finally {
    try { runSessionMaintenance(store); }
    catch { process.stderr.write("raw: session maintenance deferred\n"); }
    store.close();
  }
}

void run().catch((error) => {
  process.stderr.write(`raw: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = error instanceof InputError ? 2 : 1;
});
