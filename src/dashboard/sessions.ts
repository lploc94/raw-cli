import { ProcessControls } from "../processes/controls.js";
import { ProcessError } from "../processes/contract.js";
import { terminalText, type CommandRecord } from "../processes/presentation.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { InteractionService } from "../interactions/service.js";
import { InteractionError, type InteractionRequest } from "../interactions/contract.js";
import { FormValidationError } from "../panels/forms.js";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { record } from "../management/agents.js";
import { loadConfig } from "../config.js";
import { PanelActionError, resolveAction } from "../panels/actions.js";
import { ToolRegistry } from "../tools/registry.js";
import { knownPanelDeclarations, type KnownPanels } from "../panels/declarations.js";
import { buildPanelStack, presentDeclaration, presentToolView, declarationsFor, loadDeclarationsForSaved, toolViewStackItem, type LoadedDeclarations, type PanelStackItem } from "../panels/stack.js";
import { BACKEND_LABELS } from "../backends/config.js";
import { discoverBackendOptions } from "../backends/discovery.js";
import { backendControls } from "../backends/options.js";
import { parseRequestOverride, requestControls, RequestOverrideError, type RequestControl, type RequestOverride } from "../request-controls.js";
import { loadSelectedSkills } from "../skills/loader.js";
import type { UserBlock } from "../llm/types.js";
import { readManagedConfig } from "../management/config.js";
import { SessionOperations, type AttachSessionRuntime, type SessionOperation } from "../sessions/operations.js";
import { SessionOperationError, terminalOperationStates, type OperationIntent } from "../sessions/operation-types.js";
import { projectHistoryItem, userAttachmentBlocks, type HistoryView, type QueuedInputView } from "../sessions/view.js";
import type { Page, SessionSummary } from "../sessions/store.js";
import type { SessionMetrics } from "../sessions/metrics.js";
import { Approvals, type Approval } from "./approvals.js";
import { DashboardError, readBody, textField } from "./errors.js";
import { AttachmentStaging, type AttachmentInfo } from "./attachments.js";
import { sendFullOutput, storedFullOutput } from "./full-results.js";
import { listWorkspaceFiles, readWorkspaceFileText, readWorkspaceImage, searchWorkspaceFiles, workspaceFileLink, workspaceLinkPath } from "./files.js";
import { browseDirectory, listWorkspaces } from "./workspaces.js";
import { LiveOutput, type LiveSegment } from "./live-output.js";
import { SessionStreams } from "./streams.js";
import type { DashboardContext, DashboardRoute } from "./server.js";

export interface SessionSnapshot {
  session: SessionSummary; history: Page<HistoryView>; historyWatermark: number;
  ownership: "idle" | "here" | "elsewhere"; operations: SessionOperation[];
  metrics: SessionMetrics | null; metricsStale: boolean;
  context: { summary?: string; messageCount: number }; live: LiveSegment[]; approvals: Approval[];
  /** The session's saved agent and its committed panels; authoritative for the dashboard's panel state (§13.1). */
  agent: string | null; panels: PanelStackItem[]; commands?: CommandRecord[]; commandsOmitted?: number; interactions?: InteractionRequest[];
  /** Messages waiting for the agent, oldest first (docs/dashboard-api.md). */
  inputs: QueuedInputView[];
  /** A backend session's controls, from what its CLI offered when last asked (docs/dashboard-api.md). */
  backendOptions?: RequestControl[];
}
export function workspacePath(value: unknown, base: string): string {
  const input = textField(value, "cwd", 4096);
  try { const path = realpathSync.native(resolve(base, input)); if (statSync(path).isDirectory()) return path; } catch {}
  throw new DashboardError(400, "invalid_workspace", "Choose an existing directory");
}
function stringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) throw new DashboardError(400, "invalid_input", `${field} must be an array of at most ${max} strings`);
  if (new Set(value).size !== value.length) throw new DashboardError(400, "invalid_input", `${field} must not repeat an entry`);
  return value as string[];
}
export function pageOptions(search: URLSearchParams): { before?: string; limit?: number } {
  const raw = search.get("limit"); const limit = raw === null ? undefined : Number(raw);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new DashboardError(400, "invalid_limit", "limit must be 1 to 100");
  return { ...(limit === undefined ? {} : { limit }), ...(search.has("before") ? { before: search.get("before")! } : {}) };
}
export function createSessionRoutes(context: DashboardContext, attach?: AttachSessionRuntime): DashboardRoute[] {
  const store = context.store;
  if (!store) return [async (request) => {
    if (/^\/api\/(?:workspaces|sessions|operations|permissions|activity)(?:\/|\?|$)/.test(request.url ?? "")) throw new DashboardError(503, "store_unavailable", context.storeDiagnostic ?? "Session store is unavailable");
    return false;
  }];
  const output = new LiveOutput(join(dirname(store.path), "dashboard-live"));
  let streams!: SessionStreams;
  const processes = new ProcessSupervisor({ store, publishCommands: (sessionId,items,omitted) => { if(streams) streams.publish(sessionId,"commands",{items,...(omitted?{omitted}:{})}); } }); context.processes = processes;
  const interactions = new InteractionService({ store, available: true, publish: request => {
    if (streams) streams.publish(request.identity.sessionId!, "interaction", request, request.identity.operationId);
  } });
  const approvals = new Approvals((approval, status) => streams.publish(approval.sessionId, "approval", { ...approval, status }, approval.operationId));
  const processControls = new ProcessControls({store,processes,configPath:context.configPath,env:context.env,approve:(control,timeout)=>approvals.forOperation(control,()=>timeout),publish:control=>{if(streams)streams.publish(control.sessionId,"process_control",control);} });
  const operations: SessionOperations = new SessionOperations({ store, interactions, processes, env: context.env, ...(attach ? { attach } : {}),
    approve: (operation) => approvals.forOperation(operation, () => operations.approvalTimeout(operation.id)) });
  context.operations = operations;
  const runningByWorkspace = () => {
    const counts = new Map<string, number>();
    for (const id of operations.activeIds()) {
      const operation = store.getOperation(id); const session = operation && store.getSession(operation.sessionId);
      const path = session && store.workspaceCanonicalPath(session.workspaceId);
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  };
  const staging = new AttachmentStaging(); context.attachments = staging;
  context.onClose(() => staging.clear());
  const composer = async (name: string) => {
    const options = { cwd: context.cwd, configPath: context.configPath, env: context.env };
    const config = await readManagedConfig(options);
    if (!Object.hasOwn(record(config.data?.agents), name)) throw new DashboardError(404, "not_found", `Agent ${name} is not configured`);
    // The effective selection (direct agents and installed package agents) needs no model credentials; a broken skill only empties the list.
    let vision = false; let skills: Array<{ name: string; description: string }> = []; let controls: RequestControl[] = [];
    let backend: { kind: string; label: string } | undefined;
    try {
      const runtime = await loadConfig({ ...options, configPath: context.configPath, flags: { agent: name }, requireModel: false });
      vision = runtime.modelConfig?.vision === true;
      if (runtime.backend) {
        // Images reach the runner, which sends each as a description when the CLI does not take images.
        vision = true;
        backend = { kind: runtime.backend.kind, label: BACKEND_LABELS[runtime.backend.kind] };
      }
      if (runtime.modelConfig) controls = requestControls(runtime.modelConfig.provider, runtime.modelConfig.method, runtime.modelConfig.request);
      for (const skillId of runtime.skillIds) {
        try { // one broken skill must not hide the others
          const [skill] = await loadSelectedSkills({ selectedIds: [skillId], configPath: runtime.configPath,
            env: context.env, cwd: context.cwd, globalConfigRoot: runtime.globalConfigRoot, packageSkills: runtime.packageSkills });
          if (skill) skills.push({ name: skill.name, description: skill.description });
        } catch { /* skipped */ }
      }
    } catch { /* metadata stays best-effort so the composer never blocks */ }
    return { vision, skills, controls, ...(backend ? { backend } : {}), attachmentKinds: staging.kinds.list().map((kind) => ({ id: kind.id, accept: kind.mimeTypes, maxBytes: kind.maxBytes, enabled: true,
      ...(kind.needsVision && !vision ? { warning: "This agent cannot see images; it will receive a text placeholder instead." } : {}) })) };
  };
  /**
   * The controls of a backend agent before its session has asked the CLI: what the backend offers to a new conversation
   * set up as the agent's. A backend that cannot be asked gives no controls and a warning; sending stays possible.
   */
  const backendOptions = async (name: string): Promise<{ controls: RequestControl[]; warning?: string }> => {
    const config = await readManagedConfig({ cwd: context.cwd, configPath: context.configPath, env: context.env });
    if (!Object.hasOwn(record(config.data?.agents), name)) throw new DashboardError(404, "not_found", `Agent ${name} is not configured`);
    let runtime;
    try { runtime = await loadConfig({ cwd: context.cwd, configPath: context.configPath, env: context.env, flags: { agent: name }, requireModel: false }); }
    catch (error) { return { controls: [], warning: error instanceof Error ? error.message : String(error) }; }
    if (!runtime.backend) return { controls: [] };
    const found = await (context.discoverBackend ?? discoverBackendOptions)(runtime, context.cwd, context.env);
    return { controls: backendControls(found.offered), ...(found.warning ? { warning: found.warning } : {}) };
  };
  const agentControls = async (name: string): Promise<{ controls: RequestControl[]; backend: boolean }> => {
    try {
      const runtime = await loadConfig({ cwd: context.cwd, configPath: context.configPath, env: context.env, flags: { agent: name }, requireModel: false });
      if (runtime.backend) return { controls: [], backend: true };
      return { controls: runtime.modelConfig ? requestControls(runtime.modelConfig.provider, runtime.modelConfig.method, runtime.modelConfig.request) : [], backend: false };
    } catch { return { controls: [], backend: false }; }
  };
  const requireSession = (id: string): SessionSummary => { const value = store.getSession(id); if (!value) throw new DashboardError(404, "not_found", store.missingSessionMessage()); return value; };
  const requireOperation = (id: string): SessionOperation => { const value = store.getOperation(id); if (!value) throw new DashboardError(404, "not_found", "Operation not found"); requireSession(value.sessionId); return value; };
  const metrics = (id: string) => {
    const active = operations.activeIds().find((op) => store.getOperation(op)?.sessionId === id);
    const value = (active ? operations.metrics(active) : undefined) ?? store.getLastSessionMetrics(id) ?? null;
    return { metrics: value, metricsStale: !!value && value.historyWatermark !== store.historyWatermark(id) };
  };
  /** Declarations come from manifests and config only. Any failure degrades to "unknown" so panels never block the chat. */
  const knownPanels = async (agentName: string | undefined): Promise<KnownPanels | undefined> => {
    if (!agentName) return undefined;
    try {
      const runtime = await loadConfig({ cwd: context.cwd, configPath: context.configPath, env: context.env, flags: { agent: agentName }, requireModel: false });
      const known = await knownPanelDeclarations(runtime, { cwd: context.cwd, env: context.env });
      const policy = new ToolRegistry(runtime.toolRules);
      return { ...known, denied: (owner: string) => policy.policyEffect(owner) === "deny" };
    } catch { return undefined; }
  };
  const knownForSession = (id: string) => loadDeclarationsForSaved(() => store.getSession(id)?.agentName, knownPanels);
  const withInteractions = (sessionId: string, items: PanelStackItem[]): PanelStackItem[] => items.map(item => {
    const interaction = store.latestPanelInteraction(sessionId, item.owner, item.declaration.id);
    if (!interaction) return item;
    // A waiting sidebar form is durable even before the ordinary tool-result transaction.
    return { ...item, interaction, ...(interaction.state === "pending" ? { document: interaction.document } : {}) };
  });
  /**
   * A turn's request override, file references and staged attachments, as blocks, shared by `POST /operations` and
   * `POST /inputs`. `replayed` runs after each await: a duplicate accepted meanwhile returns its receipt instead, so the
   * staged items are consumed once.
   */
  const prepareTurn = async <T>(sessionId: string, intent: OperationIntent, body: Record<string, unknown>, ids: string[], files: string[],
    replayed: () => T | undefined): Promise<{ replay: T } | { blocks?: UserBlock[]; override?: RequestOverride }> => {
    let override: RequestOverride | undefined;
    if (body.request !== undefined) {
      const agent = await agentControls(intent.agentName);
      try { override = parseRequestOverride(body.request, agent.controls, { backend: agent.backend }); }
      catch (error) { if (error instanceof RequestOverrideError) throw new DashboardError(422, "invalid_request_option", error.message); throw error; }
      if (override.effort === undefined && override.serviceTier === undefined && override.backend === undefined) override = undefined;
      const replay = replayed(); if (replay !== undefined) return { replay };
    }
    if (!ids.length && !files.length) return override ? { override } : {};
    const staged = staging.resolve(sessionId, ids); const session = requireSession(sessionId);
    const links: UserBlock[] = [];
    for (const file of files) links.push(await workspaceFileLink(session.cwd, file));
    const blocks: UserBlock[] = [{ type: "text", text: intent.input! }, ...links, ...staged.map((item) => staging.kinds.list().find((kind) => kind.id === item.kind)!.toBlock(item))];
    // No await separates this check from the caller's submit, so a concurrent duplicate cannot consume staged items.
    const replay = replayed(); if (replay !== undefined) return { replay };
    return { blocks, ...(override ? { override } : {}) };
  };
  /**
   * Where a sent message went, by its request id: waiting (`queued`), delivered into a running turn (`delivered`), or a
   * turn (`operation`, started directly or from the queue). With `intent`, a different body under the same id is a conflict.
   */
  const inputReceipt = (sessionId: string, clientRequestId: string, intent?: OperationIntent):
    { operation: SessionOperation } | { queued: QueuedInputView } | { delivered: { operationId: string; historySequence: number } } | undefined => {
    const row = store.findQueuedInput(sessionId, clientRequestId);
    if (row) {
      if (intent && store.requestHash(intent) !== row.requestHash) throw new SessionOperationError("conflict", "client request ID conflicts with an earlier submitted intent");
      if (row.state === "deleted") throw new DashboardError(409, "deleted", "This message was deleted before it was sent");
      if (row.state === "delivered") return { delivered: { operationId: row.operationId!, historySequence: row.historySequence! } };
      if (row.state === "taken") return { operation: store.getOperation(row.operationId!)! };
      return { queued: store.queuedInputView(sessionId, row.id)! };
    }
    if (!store.findOperation(sessionId, clientRequestId)) return undefined;
    // `submit` returns the existing receipt, or answers `conflict` for a different body.
    return { operation: intent ? operations.submit(intent) : store.findOperation(sessionId, clientRequestId)! };
  };
  const snapshot = (id: string, loaded?: LoadedDeclarations): SessionSnapshot => {
    store.recoverInteractions();
    const session = requireSession(id); const historyWatermark = store.historyWatermark(id);
    const page = store.getSessionHistory({ sessionId: id, limit: 50, atOrBefore: historyWatermark });
    const receipts = store.listOperations(id, 20);
    const commands = processes.commands.listing(id);
    const offered = backendControls(store.externalOffered(id));
    return { session, ...(offered.length ? { backendOptions: offered } : {}), history: { ...page, items: page.items.map(projectHistoryItem) }, historyWatermark,
      ownership: streams.ownership(id), operations: receipts, ...metrics(id), context: store.getContextSummary(id),
      live: output.list(new Set(receipts.filter((op) => !terminalOperationStates.has(op.state)).map((op) => op.id))), approvals: approvals.list(id),
      agent: session.agentName ?? null, commands: commands.items, ...(commands.omitted ? { commandsOmitted: commands.omitted } : {}), interactions: store.pendingInteractions(id),
      inputs: store.queuedInputs(id), panels: withInteractions(id, buildPanelStack(declarationsFor(session.agentName, loaded), store.listSessionPanels(id))) };
  };
  streams = new SessionStreams(context, output, snapshot, knownForSession);
  const unsubscribe = operations.subscribe((message) => streams.observe(message));
  context.onClose(() => processControls.close());
  context.onClose(() => { unsubscribe(); interactions.close(); approvals.close(); streams.close(); output.close(); });
  return [async (request, response) => {
    const url = new URL(request.url!, "http://localhost"); const path = url.pathname; const method = request.method;
    if (!/^\/api\/(?:workspaces|sessions|operations|permissions|activity|agents\/[^/]+\/(?:composer|backend-options))(?:\/|$)/.test(path)) return false;
    const reply = (value: unknown, status = 200) => { context.json(response, status, value); return true; };
    const agentRoute = /^\/api\/agents\/([^/]+)\/composer$/.exec(path);
    if (agentRoute && method === "GET") return reply(await composer(decodeURIComponent(agentRoute[1]!)));
    const optionsRoute = /^\/api\/agents\/([^/]+)\/backend-options$/.exec(path);
    if (optionsRoute && method === "GET") return reply(await backendOptions(decodeURIComponent(optionsRoute[1]!)));
    if (path === "/api/workspaces" && method === "GET") return reply(await listWorkspaces(store, { current: context.cwd, env: context.env, search: url.searchParams, running: runningByWorkspace }));
    if (path === "/api/workspaces/browse" && method === "GET") return reply(await browseDirectory(url.searchParams, context.env));
    if (path === "/api/workspaces/files" && method === "GET") {
      const cwd = url.searchParams.has("cwd") ? workspacePath(url.searchParams.get("cwd"), context.cwd) : context.cwd;
      return reply(await listWorkspaceFiles(cwd, { bypassCache: url.searchParams.get("refresh") === "1" }));
    }
    if (path === "/api/workspaces/file" && method === "GET") {
      const wanted = url.searchParams.get("path");
      if (wanted === null || wanted === "") throw new DashboardError(400, "invalid_input", "path is required");
      const cwd = url.searchParams.has("cwd") ? workspacePath(url.searchParams.get("cwd"), context.cwd) : context.cwd;
      if (url.searchParams.get("raw") === "1") {
        const image = await readWorkspaceImage(cwd, wanted);
        response.writeHead(200, { "Content-Type": image.mediaType, "Content-Length": image.bytes.length,
          "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
        response.end(image.bytes);
        return true;
      }
      return reply(await readWorkspaceFileText(cwd, wanted));
    }
    if (path === "/api/workspaces/validate" && method === "POST") return reply({ cwd: workspacePath((await context.readJson(request)).cwd, context.cwd) });
    if (path === "/api/activity" && method === "GET") {
      const all = store.listOperations(undefined, 100).filter((op) => terminalOperationStates.has(op.state) && store.getSession(op.sessionId));
      const selected = [...new Map([...operations.activeIds().map((id) => store.getOperation(id)!).filter(Boolean), ...all].map((op) => [op.id, op])).values()];
      return reply({ operations: selected.slice(0, 100).map((op) => ({ id: op.id, sessionId: op.sessionId, kind: op.kind, state: op.state,
        agentName: op.agentName, acceptedAt: op.acceptedAt, updatedAt: op.updatedAt, controllable: operations.owns(op.id) })),
      // The cross-session list never shows call content: the headline comes from the arguments too.
      approvals: approvals.list().map(({ arguments: _args, title: _title, summary: _summary, ...metadata }) => metadata) });
    }
    if (path === "/api/sessions") {
      if (method === "GET") {
        try { return reply(store.listSessions({ ...pageOptions(url.searchParams),
          ...(url.searchParams.has("cwd") ? { cwd: workspacePath(url.searchParams.get("cwd"), context.cwd) } : {}),
          ...(url.searchParams.has("title") ? { title: url.searchParams.get("title")! } : {}) })); }
        catch (error) { if (error instanceof DashboardError) throw error; throw new DashboardError(400, "invalid_cursor", String(error)); }
      }
      if (method === "POST") {
        const body = await context.readJson(request); const cwd = workspacePath(body.cwd ?? context.cwd, context.cwd);
        const config = await readManagedConfig({ configPath: context.configPath, cwd: context.cwd, env: context.env });
        if (!config.data) throw new DashboardError(422, "invalid_config", config.diagnostic ?? "Configure an agent first");
        const agentName = textField(body.agent ?? context.preferredAgent ?? config.data.default_agent ?? "raw", "agent");
        if (!Object.hasOwn(record(config.data.agents), agentName)) throw new DashboardError(422, "unknown_agent", `Agent ${agentName} is not configured`);
        return reply(store.createSession({ cwd, agentName, configPath: context.configPath,
          title: body.title === undefined ? "New chat" : textField(body.title, "title", 200) }), 201);
      }
    }
    const attachmentRoute = /^\/api\/sessions\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(path);
    if (attachmentRoute) {
      const id = decodeURIComponent(attachmentRoute[1]!); requireSession(id);
      if (!attachmentRoute[2] && method === "POST") {
        const mimeType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const kind = staging.kinds.byMime(mimeType);
        if (!kind) { request.resume(); throw new DashboardError(415, "unsupported_media_type", "Unsupported attachment type"); }
        const bytes = await readBody(request, kind.maxBytes).catch((error) => {
          throw error instanceof DashboardError && error.code === "body_too_large"
            ? new DashboardError(413, "attachment_too_large", `Attachment exceeds ${kind.maxBytes} bytes`) : error; });
        let name = "attachment"; const header = request.headers["x-raw-filename"];
        if (typeof header === "string") { try { name = decodeURIComponent(header); } catch { name = header; } }
        return reply(staging.stage(id, { mimeType, name: name.replace(/[\\/\0]/g, "_"), bytes }), 201);
      }
      if (attachmentRoute[2] && method === "DELETE") return reply({ removed: staging.remove(id, decodeURIComponent(attachmentRoute[2])) });
      if (attachmentRoute[2] && method === "GET") {
        // The bytes of a staged item, so the composer can keep a copy of an image an edited message brought back.
        const item = staging.read(id, decodeURIComponent(attachmentRoute[2]));
        if (!item) throw new DashboardError(404, "not_found", "Attachment not found");
        response.writeHead(200, { "Content-Type": item.mimeType, "Content-Length": item.bytes.length, "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store", "Content-Disposition": "inline" });
        response.end(item.bytes);
        return true;
      }
    }
    const historyAttachment = /^\/api\/sessions\/([^/]+)\/history\/(\d+)\/attachments\/(\d+)$/.exec(path);
    if (historyAttachment && method === "GET") {
      const id = decodeURIComponent(historyAttachment[1]!); requireSession(id);
      const notFound = () => new DashboardError(404, "not_found", "Attachment not found");
      const item = store.getSessionHistoryItem(id, Number(historyAttachment[2]));
      if (!item || item.kind !== "user") throw notFound();
      const block = userAttachmentBlocks(item.payload.input)[Number(historyAttachment[3])];
      const found = block && staging.kinds.content(block);
      if (!found || !found.kind.mimeTypes.includes(found.content.mimeType)) throw notFound();
      response.writeHead(200, { "Content-Type": found.content.mimeType, "Content-Length": found.content.bytes.length, "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" });
      response.end(found.content.bytes);
      return true;
    }
    const fileSearch = /^\/api\/sessions\/([^/]+)\/files$/.exec(path);
    if (fileSearch && method === "GET") {
      const session = requireSession(decodeURIComponent(fileSearch[1]!));
      const raw = url.searchParams.get("limit"); const limit = raw === null ? 20 : Number(raw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DashboardError(400, "invalid_limit", "limit must be 1 to 50");
      return reply({ items: await searchWorkspaceFiles(session.cwd, url.searchParams.get("q") ?? "", limit) });
    }
    const fullResult = /^\/api\/sessions\/([^/]+)\/tool-results\/([^/]+)\/full$/.exec(path);
    if (fullResult && method === "GET") {
      const id = decodeURIComponent(fullResult[1]!); requireSession(id);
      const stored = storedFullOutput(store, id, decodeURIComponent(fullResult[2]!));
      if (!stored) throw new DashboardError(404, "not_found", "Tool call not found in this session");
      await sendFullOutput(response, stored);
      return true;
    }
    const commandRoute = /^\/api\/sessions\/([^/]+)\/commands(?:\/([^/]+)(?:\/(output|stop|controls)(?:\/([^/]+))?)?)?$/.exec(path);
    if(commandRoute) {
      const sessionId=decodeURIComponent(commandRoute[1]!);requireSession(sessionId);
      const id=commandRoute[2]===undefined?undefined:decodeURIComponent(commandRoute[2]);
      try {
        if(id===undefined&&method==="GET"){const {items,omitted}=processes.commands.listing(sessionId);return reply({items,...(omitted?{omitted}:{})});}
        if(id&&commandRoute[3]==="output"&&method==="GET") {
          const cursor=url.searchParams.has("cursor")?Number(url.searchParams.get("cursor")):0;
          const maxBytes=url.searchParams.has("maxBytes")?Number(url.searchParams.get("maxBytes")):65536;
          const row=processes.commands.list(sessionId).find(item=>item.id===id);
          if(!row)throw new DashboardError(404,"process_not_found","command not found in this session");
          if(row.kind==="foreground")return reply(processes.commands.output(sessionId,id,cursor,maxBytes));
          const result=await processControls.read(sessionId,id,{action:"output",id,cursor,max_bytes:maxBytes});
          if(result.isError)throw new DashboardError(result.code==="invalid_arguments"?400:403,result.code??"process_error",result.content.map(c=>c.type==="text"?c.text:"").join("\n"));
          const page=result.host?.page;
          if(!page)throw new DashboardError(500,"process_error","process output unavailable");
          // The page's bytes are the result's channel blocks; the cursor line has no channel.
          const blocks=result.content.flatMap(c=>c.type==="text"&&c.channel?[{channel:c.channel,text:c.text}]:[]);
          // Offsets count the unsanitized bytes from the page's first byte.
          let start=page.cursor;
          const chunks=blocks.map(b=>{const chunk={channel:b.channel,start,end:start+Buffer.byteLength(b.text),text:terminalText(b.text)};start=chunk.end;return chunk;});
          return reply({id,chunks,cursor:page.total,nextCursor:page.next,earliestCursor:page.earliestCursor,droppedBytes:page.droppedBytes,truncated:page.truncated});
        }
        if(id&&commandRoute[3]==="stop"&&method==="POST")return reply(processControls.submit(sessionId,id,textField((await context.readJson(request)).clientRequestId,"clientRequestId",128)),202);
        if(id&&commandRoute[3]==="controls"&&commandRoute[4]&&method==="GET"){
          const receipt=processControls.get(sessionId,id,decodeURIComponent(commandRoute[4]));
          if(!receipt)throw new DashboardError(404,"not_found","Process control not found");return reply(receipt);
        }
      } catch(error){if(error instanceof ProcessError)throw new DashboardError(error.code==="process_not_found"?404:error.code==="invalid_arguments"?400:409,error.code,error.message);throw error;}
    }
    const interactionRoute = /^\/api\/sessions\/([^/]+)\/interactions\/([^/]+)(\/responses)?$/.exec(path);
    if (interactionRoute) {
      const sessionId = decodeURIComponent(interactionRoute[1]!); requireSession(sessionId);
      const requestId = decodeURIComponent(interactionRoute[2]!);
      store.recoverInteractions();
      if (method === "GET" && !interactionRoute[3]) {
        const value = interactions.get(sessionId, requestId);
        if (!value) throw new DashboardError(404, "interaction_not_found", "Request not found in this session");
        const loaded = await knownForSession(sessionId);
        return reply({ ...value, presentation: presentDeclaration(value.declaration, value.identity.owner, declarationsFor(requireSession(sessionId).agentName, loaded)) });
      }
      if (method === "POST" && interactionRoute[3]) {
        try { return reply(interactions.respond(sessionId, requestId, await context.readJson(request))); }
        catch (error) {
          if (error instanceof FormValidationError) throw new DashboardError(422, error.code, error.message);
          if (error instanceof InteractionError) throw new DashboardError(error.code === "interaction_not_found" ? 404 : error.code === "interaction_conflict" ? 409 : 422, error.code, error.message);
          throw error;
        }
      }
    }
    const viewRoute = /^\/api\/sessions\/([^/]+)\/views\/([^/]+)$/.exec(path);
    if (viewRoute && method === "GET") {
      const id = decodeURIComponent(viewRoute[1]!); requireSession(id);
      const view = store.getToolView(id, decodeURIComponent(viewRoute[2]!));
      if (!view) throw new DashboardError(404, "unknown_view", "This tool view does not exist in the session");
      const loaded = await knownForSession(id);
      return reply(presentToolView(view, declarationsFor(requireSession(id).agentName, loaded)));
    }
    const panelRoute = /^\/api\/sessions\/([^/]+)\/panels(?:\/([^/]+))?$/.exec(path);
    if (panelRoute && method === "GET") {
      const id = decodeURIComponent(panelRoute[1]!); const session = requireSession(id);
      const requested = url.searchParams.get("agent");
      const agent = requested ?? session.agentName ?? null;
      if (requested !== null) {
        const config = await readManagedConfig({ configPath: context.configPath, cwd: context.cwd, env: context.env });
        if (!Object.hasOwn(record(config.data?.agents), requested)) throw new DashboardError(422, "unknown_agent", `Agent ${requested} is not configured`);
      }
      const items = withInteractions(id, buildPanelStack(await knownPanels(agent ?? undefined), store.listSessionPanels(id)));
      if (panelRoute[2] === undefined) return reply({ agent, items });
      const wanted = decodeURIComponent(panelRoute[2]);
      const found = items.find((item) => item.panel === wanted);
      if (!found) throw new DashboardError(404, "unknown_panel", `Panel ${wanted} does not exist in this session`);
      return reply(found);
    }
    const actionRoute = /^\/api\/sessions\/([^/]+)\/(panels|views)\/([^/]+)\/actions$/.exec(path);
    if (actionRoute && method === "POST") {
      const id = decodeURIComponent(actionRoute[1]!); const session = requireSession(id);
      const instanceId = actionRoute[2] === "views" ? decodeURIComponent(actionRoute[3]!) : undefined;
      const historical = instanceId ? store.getToolView(id, instanceId) : undefined;
      if (instanceId && !historical) throw new DashboardError(404, "unknown_view", "This tool view does not exist in the session");
      const panel = historical?.panelId ?? decodeURIComponent(actionRoute[3]!);
      const body = await context.readJson(request);
      const clientRequestId = textField(body.clientRequestId, "clientRequestId", 128);
      const agent = textField(body.agent, "agent");
      const request_ = { action: textField(body.action, "action", 64),
        ...(body.block === undefined ? {} : { block: textField(body.block, "block", 64) }), ...(body.item === undefined ? {} : { item: textField(body.item, "item", 128) }) };
      const intent: OperationIntent = { sessionId: id, clientRequestId, kind: "panel_action", agentName: agent, configPath: context.configPath, action: { panel, ...request_,
        ...(instanceId ? { viewInstanceId: instanceId } : {}) } };
      // A replayed request id returns the existing receipt and never re-validates against newer state.
      if (store.findOperation(id, clientRequestId)) return reply({ operationId: operations.submit(intent).id }, 202);
      // The saved agent is the one policy and dispatch use; a view showing another agent must not run an action under it.
      if (session.agentName !== agent) throw new DashboardError(409, "agent_mismatch", `This session's saved agent is ${session.agentName ?? "not set"}; send a message to switch to ${agent} first`);
      const known = await knownPanels(agent);
      const current = known?.declared.find(entry => `${entry.owner}#${entry.declaration.id}` === panel)?.declaration;
      const found = historical ? toolViewStackItem(historical, current ?? historical.declaration, !current)
        : buildPanelStack(known, store.listSessionPanels(id)).find((item) => item.panel === panel);
      if (!found) throw new DashboardError(404, "unknown_panel", `Panel ${panel} does not exist in this session`);
      if (found.stale) throw new DashboardError(409, "stale_panel", "The tool that owns this panel is not selected by this agent");
      // `deny` hides the tool actions; a stale request for one is forbidden and nothing runs.
      const declared = known?.declared.find((entry) => `${entry.owner}#${entry.declaration.id}` === panel)?.declaration.actions.find((action) => action.id === request_.action);
      if (declared?.kind === "tool" && known?.denied?.(found.owner)) throw new DashboardError(403, "action_denied", "Policy denies this tool");
      let resolved;
      try { resolved = resolveAction(found.declaration, request_, found.document); }
      catch (error) {
        if (error instanceof PanelActionError) throw new DashboardError(422, "invalid_action", error.message);
        throw error;
      }
      if (resolved.action.kind !== "tool") throw new DashboardError(422, "invalid_action", "Prompt actions run in the browser");
      if (store.sessionIsBusy(id)) throw new DashboardError(409, "session_busy", "Wait for the active operation to finish");
      return reply({ operationId: operations.submit(intent).id }, 202);
    }
    const inputRoute = /^\/api\/sessions\/([^/]+)\/inputs(?:\/([^/]+)(\/send-now|\/edit)?)?$/.exec(path);
    if (inputRoute) {
      const id = decodeURIComponent(inputRoute[1]!); requireSession(id);
      if (inputRoute[2] === undefined && method === "GET") {
        store.recoverOperations(); const key = url.searchParams.get("clientRequestId");
        if (key === null) return reply({ items: store.queuedInputs(id) });
        const found = inputReceipt(id, key); if (!found) throw new DashboardError(404, "not_found", "No receipt exists for this request");
        return reply(found);
      }
      if (inputRoute[2] === undefined && method === "POST") {
        const body = await context.readJson(request);
        const clientRequestId = textField(body.clientRequestId, "clientRequestId", 128);
        if (body.mode !== "queue" && body.mode !== "interrupt") throw new DashboardError(400, "invalid_mode", "mode must be queue or interrupt");
        const intent: OperationIntent = { sessionId: id, clientRequestId, kind: "turn", agentName: textField(body.agent, "agent"),
          configPath: context.configPath, input: textField(body.input, "input", 1024 * 1024) };
        const ids = stringList(body.attachments, "attachments", 8); const files = stringList(body.files, "files", 20);
        // A replayed request id resolves before staged attachments are read: they were consumed by the first request.
        const prior = inputReceipt(id, clientRequestId, intent); if (prior) return reply(prior, 202);
        const prepared = await prepareTurn(id, intent, body, ids, files, () => inputReceipt(id, clientRequestId, intent));
        if ("replay" in prepared) return reply(prepared.replay, 202);
        const sent = operations.enqueue(intent, { mode: body.mode, ...(prepared.blocks ? { blocks: prepared.blocks } : {}),
          ...(prepared.override ? { request: prepared.override } : {}) });
        staging.release(ids);
        return reply(sent, 202);
      }
      if (inputRoute[2] !== undefined && inputRoute[3] === "/send-now" && method === "POST") return reply(operations.sendNow(id, decodeURIComponent(inputRoute[2])), 202);
      if (inputRoute[2] !== undefined && inputRoute[3] === "/edit" && method === "POST") {
        // The message comes back as the composer holds it: its text, its files as workspace paths, and its images staged again.
        let root: string | undefined; try { root = realpathSync.native(requireSession(id).cwd); } catch { root = undefined; }
        const staged: AttachmentInfo[] = [];
        try {
          const back = store.takeBackQueuedInput(id, decodeURIComponent(inputRoute[2]), (input, blocks) => {
            const files: string[] = [];
            for (const block of typeof blocks === "string" ? [] : blocks) {
              if (block.type === "resource_link") { const file = root && workspaceLinkPath(root, block.uri); if (file) files.push(file); continue; }
              const found = staging.kinds.content(block);
              if (found) staged.push(staging.stage(id, { ...found.content, name: (block.type === "image" ? block.name : undefined) ?? "attachment" }));
            }
            return { input, files, attachments: staged };
          });
          operations.publishInputs(id);
          return reply(back);
        } catch (error) { staging.release(staged.map((item) => item.id)); throw error; }
      }
      if (inputRoute[2] !== undefined && !inputRoute[3] && method === "DELETE") {
        store.deleteQueuedInput(id, decodeURIComponent(inputRoute[2]));
        operations.publishInputs(id);
        response.writeHead(204, { "Cache-Control": "no-store" }); response.end();
        return true;
      }
    }
    const sessionRoute = /^\/api\/sessions\/([^/]+)(?:\/(history|operations|metrics|events|output))?$/.exec(path);
    if (sessionRoute) {
      const id = decodeURIComponent(sessionRoute[1]!); const action = sessionRoute[2]; requireSession(id);
      if (!action) {
        if (method === "GET") return reply(snapshot(id, await knownForSession(id)));
        if (method === "PATCH") return reply(store.renameSession(id, textField((await context.readJson(request)).title, "title", 200)));
        if (method === "DELETE") {
          if (store.sessionIsBusy(id)) throw new DashboardError(409, "busy", "Stop the active operation or wait for its current owner before deleting");
          try { await processes.deleteSession(id); } catch (error) { throw new DashboardError(409, "busy", String(error)); }
          return reply({ deleted: true });
        }
      }
      if (action === "history" && method === "GET") {
        try { const page = store.getSessionHistory({ sessionId: id, ...pageOptions(url.searchParams) }); return reply({ ...page, items: page.items.map(projectHistoryItem) }); }
        catch (error) { if (error instanceof DashboardError) throw error; throw new DashboardError(400, "invalid_cursor", String(error)); }
      }
      if (action === "metrics" && method === "GET") return reply(metrics(id));
      if (action === "events" && (method === "GET" || method === "POST")) { await streams.subscribe(id, response, typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined); return true; }
      if (action === "output" && method === "GET") {
        const op = requireOperation(textField(url.searchParams.get("operationId"), "operationId"));
        if (op.sessionId !== id) throw new DashboardError(404, "not_found", "Output not found in this session");
        return reply(output.read(op.id, textField(url.searchParams.get("segmentId"), "segmentId"), Number(url.searchParams.get("offset") ?? 0)));
      }
      if (action === "operations") {
        if (method === "GET") {
          store.recoverOperations(); const key = url.searchParams.get("clientRequestId");
          if (key === null) return reply({ items: store.listOperations(id) });
          const op = store.findOperation(id, key); if (!op) throw new DashboardError(404, "not_found", "No receipt exists for this request"); return reply(op);
        }
        if (method === "POST") {
          const body = await context.readJson(request);
          if (body.kind !== "turn" && body.kind !== "compact") throw new DashboardError(400, "invalid_kind", "kind must be turn or compact");
          if (body.kind === "compact" && body.input !== undefined) throw new DashboardError(400, "invalid_input", "compact does not accept input");
          const clientRequestId = textField(body.clientRequestId, "clientRequestId", 128);
          const intent: OperationIntent = { sessionId: id, clientRequestId, kind: body.kind, agentName: textField(body.agent, "agent"), configPath: context.configPath,
            ...(body.kind === "turn" ? { input: textField(body.input, "input", 1024 * 1024) } : {}) };
          const ids = stringList(body.attachments, "attachments", 8); const files = stringList(body.files, "files", 20);
          if (body.kind === "compact" && (ids.length || files.length)) throw new DashboardError(400, "invalid_input", "compact does not accept attachments");
          if (body.kind === "compact" && body.request !== undefined) throw new DashboardError(400, "invalid_input", "compact does not accept request overrides");
          // A replayed request id returns the existing receipt and never re-reads staged items or validates a new override.
          if (body.kind !== "turn" || store.findOperation(id, clientRequestId)) return reply(operations.submit(intent), 202);
          const prepared = await prepareTurn(id, intent, body, ids, files, () => store.findOperation(id, clientRequestId) ? operations.submit(intent) : undefined);
          if ("replay" in prepared) return reply(prepared.replay, 202);
          const accepted = operations.submit(intent, prepared.blocks, prepared.override); staging.release(ids);
          return reply(accepted, 202);
        }
      }
    }
    const opRoute = /^\/api\/operations\/([^/]+)(\/cancel)?$/.exec(path);
    if (opRoute) {
      const id = decodeURIComponent(opRoute[1]!); store.recoverOperations(); requireOperation(id);
      if (!opRoute[2] && method === "GET") return reply(requireOperation(id));
      if (opRoute[2] && method === "POST") {
        if (!operations.cancel(id)) throw new DashboardError(409, "not_owned", "This dashboard has no active operation to stop");
        return reply({ cancelling: true });
      }
    }
    const permission = /^\/api\/permissions\/([^/]+)$/.exec(path);
    if (permission && method === "POST") {
      const body = await context.readJson(request);
      if (typeof body.allow !== "boolean") throw new DashboardError(400, "invalid_input", "allow must be a boolean");
      approvals.answer(decodeURIComponent(permission[1]!), textField(body.operationId, "operationId"), textField(body.callId, "callId"), body.allow);
      return reply({ answered: true });
    }
    return false;
  }];
}
