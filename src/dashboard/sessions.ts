import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { record } from "../management/agents.js";
import { readManagedConfig } from "../management/config.js";
import { SessionOperations, type AttachSessionRuntime, type SessionOperation } from "../sessions/operations.js";
import { terminalOperationStates } from "../sessions/operation-types.js";
import { projectHistoryItem, type HistoryView } from "../sessions/view.js";
import type { Page, SessionSummary } from "../sessions/store.js";
import type { SessionMetrics } from "../sessions/metrics.js";
import { Approvals, type Approval } from "./approvals.js";
import { DashboardError, textField } from "./errors.js";
import { LiveOutput, type LiveSegment } from "./live-output.js";
import { SessionStreams } from "./streams.js";
import type { DashboardContext, DashboardRoute } from "./server.js";

export interface SessionSnapshot {
  session: SessionSummary; history: Page<HistoryView>; historyWatermark: number;
  ownership: "idle" | "here" | "elsewhere"; operations: SessionOperation[];
  metrics: SessionMetrics | null; metricsStale: boolean;
  context: { summary?: string; messageCount: number }; live: LiveSegment[]; approvals: Approval[];
}
export function workspacePath(value: unknown, base: string): string {
  const input = textField(value, "cwd", 4096);
  try { const path = realpathSync(resolve(base, input)); if (statSync(path).isDirectory()) return path; } catch {}
  throw new DashboardError(400, "invalid_workspace", "Choose an existing directory");
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
  const approvals = new Approvals((approval, status) => streams.publish(approval.sessionId, "approval", { ...approval, status }, approval.operationId));
  const operations: SessionOperations = new SessionOperations({ store, env: context.env, ...(attach ? { attach } : {}),
    approve: (operation) => approvals.forOperation(operation, () => operations.approvalTimeout(operation.id)) });
  context.operations = operations;
  const requireSession = (id: string): SessionSummary => { const value = store.getSession(id); if (!value) throw new DashboardError(404, "not_found", store.missingSessionMessage()); return value; };
  const requireOperation = (id: string): SessionOperation => { const value = store.getOperation(id); if (!value) throw new DashboardError(404, "not_found", "Operation not found"); requireSession(value.sessionId); return value; };
  const metrics = (id: string) => {
    const active = operations.activeIds().find((op) => store.getOperation(op)?.sessionId === id);
    const value = (active ? operations.metrics(active) : undefined) ?? store.getLastSessionMetrics(id) ?? null;
    return { metrics: value, metricsStale: !!value && value.historyWatermark !== store.historyWatermark(id) };
  };
  const snapshot = (id: string): SessionSnapshot => {
    const session = requireSession(id); const historyWatermark = store.historyWatermark(id);
    const page = store.getSessionHistory({ sessionId: id, limit: 50, atOrBefore: historyWatermark });
    const receipts = store.listOperations(id, 20);
    return { session, history: { ...page, items: page.items.map(projectHistoryItem) }, historyWatermark,
      ownership: streams.ownership(id), operations: receipts, ...metrics(id), context: store.getContextSummary(id),
      live: output.list(new Set(receipts.filter((op) => !terminalOperationStates.has(op.state)).map((op) => op.id))), approvals: approvals.list(id) };
  };
  streams = new SessionStreams(context, output, snapshot);
  const unsubscribe = operations.subscribe((message) => streams.observe(message));
  context.onClose(() => { unsubscribe(); approvals.close(); streams.close(); output.close(); });
  return [async (request, response) => {
    const url = new URL(request.url!, "http://localhost"); const path = url.pathname; const method = request.method;
    if (!/^\/api\/(?:workspaces|sessions|operations|permissions|activity)(?:\/|$)/.test(path)) return false;
    const reply = (value: unknown, status = 200) => { context.json(response, status, value); return true; };
    if (path === "/api/workspaces" && method === "GET") {
      const items = store.recentWorkspaces(); if (!items.some((item) => item.cwd === context.cwd)) items.unshift({ cwd: context.cwd, updatedAt: 0 });
      return reply({ items });
    }
    if (path === "/api/workspaces/validate" && method === "POST") return reply({ cwd: workspacePath((await context.readJson(request)).cwd, context.cwd) });
    if (path === "/api/activity" && method === "GET") {
      const all = store.listOperations(undefined, 100).filter((op) => terminalOperationStates.has(op.state) && store.getSession(op.sessionId));
      const selected = [...new Map([...operations.activeIds().map((id) => store.getOperation(id)!).filter(Boolean), ...all].map((op) => [op.id, op])).values()];
      return reply({ operations: selected.slice(0, 100).map((op) => ({ id: op.id, sessionId: op.sessionId, kind: op.kind, state: op.state,
        agentName: op.agentName, acceptedAt: op.acceptedAt, updatedAt: op.updatedAt, controllable: operations.owns(op.id) })),
      approvals: approvals.list().map(({ arguments: _args, ...metadata }) => metadata) });
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
    const sessionRoute = /^\/api\/sessions\/([^/]+)(?:\/(history|operations|metrics|events|output))?$/.exec(path);
    if (sessionRoute) {
      const id = decodeURIComponent(sessionRoute[1]!); const action = sessionRoute[2]; requireSession(id);
      if (!action) {
        if (method === "GET") return reply(snapshot(id));
        if (method === "PATCH") return reply(store.renameSession(id, textField((await context.readJson(request)).title, "title", 200)));
        if (method === "DELETE") {
          if (store.sessionIsBusy(id)) throw new DashboardError(409, "busy", "Stop the active operation or wait for its current owner before deleting");
          try { store.deleteSession(id); } catch (error) { throw new DashboardError(409, "busy", String(error)); }
          return reply({ deleted: true });
        }
      }
      if (action === "history" && method === "GET") {
        try { const page = store.getSessionHistory({ sessionId: id, ...pageOptions(url.searchParams) }); return reply({ ...page, items: page.items.map(projectHistoryItem) }); }
        catch (error) { if (error instanceof DashboardError) throw error; throw new DashboardError(400, "invalid_cursor", String(error)); }
      }
      if (action === "metrics" && method === "GET") return reply(metrics(id));
      if (action === "events" && method === "GET") { streams.subscribe(id, response, typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined); return true; }
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
          return reply(operations.submit({ sessionId: id, clientRequestId: textField(body.clientRequestId, "clientRequestId", 128),
            kind: body.kind, agentName: textField(body.agent, "agent"), configPath: context.configPath,
            ...(body.kind === "turn" ? { input: textField(body.input, "input", 1024 * 1024) } : {}) }), 202);
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
