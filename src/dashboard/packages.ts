import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { canonicalConfigPath } from "../config.js";
import { attachPackageComponent } from "../management/packages.js";
import { readManagedConfig } from "../management/config.js";
import { assertRevision } from "../management/files.js";
import { MAX_PACKAGE_ARCHIVE_BYTES, packPackage, validatePackageArchive } from "../packages/archive.js";
import { addPackageAgent } from "../packages/cli.js";
import { exportAgentPackage } from "../packages/export.js";
import { inspectPackage, type PackageReport } from "../packages/inspect.js";
import { loadPackageManifest } from "../packages/manifest.js";
import { forkPackage, installPackage, linkPackage, listInstalledPackages, packageReferences, removePackage, resolveInstalledPackage, updatePackage, type PackageEntry } from "../packages/store.js";
import { componentKinds } from "../packages/contract.js";
import { DashboardError, textField } from "./errors.js";
import { managementAction, managementInput, revisionField } from "./management.js";
import type { DashboardContext, DashboardRoute } from "./server.js";

export interface PackageStageView {
  id: string; report: PackageReport; inputs: Record<string, unknown>; sha256: string; bytes: number; canLink: boolean; expiresAt: string;
}
export interface PackageView {
  alias: string; entry: PackageEntry; report?: PackageReport; inputs?: Record<string, unknown>; usedBy?: string[]; diagnostic?: string;
}
interface Stage { view: PackageStageView; artifact: string; folder: string; sourceDirectory?: string }
const MAX_STAGES = 4, STAGE_TTL_MS = 30 * 60_000;
async function hash(path: string) {
  const sha = createHash("sha256"); for await (const bytes of createReadStream(path)) sha.update(bytes); return sha.digest("hex");
}
async function writeUpload(request: IncomingMessage, path: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DashboardError(503, "closing", "Dashboard is stopping");
  const file = await open(path, "wx", 0o600); let size = 0;
  const stop = () => request.destroy(new Error("Dashboard is stopping")); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += (chunk as Buffer).length;
      if (size > MAX_PACKAGE_ARCHIVE_BYTES) { request.resume(); throw new DashboardError(413, "body_too_large", "Package archive exceeds 128 MiB"); }
      await file.writeFile(chunk as Buffer);
    }
    if (signal.aborted || !request.complete) throw new DashboardError(400, "request_aborted", "Upload interrupted");
    await file.sync();
  } finally { signal.removeEventListener("abort", stop); await file.close(); }
}
export function createPackageRoutes(context: DashboardContext): DashboardRoute[] {
  const options = { cwd: context.cwd, configPath: context.configPath, env: context.env };
  const stagingRoot = join(context.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "raw", "dashboard-packages", context.instanceId);
  const stages = new Map<string, Stage>(), pending = new Set<Promise<unknown>>(); let preparing = 0;
  const discard = async (id: string) => { const stage = stages.get(id); if (stage) { stages.delete(id); await rm(stage.folder, { recursive: true, force: true }); } };
  const sweep = async () => { for (const [id, stage] of stages) if (Date.parse(stage.view.expiresAt) < Date.now()) await discard(id); };
  context.onClose(async () => { await Promise.allSettled([...pending]); stages.clear(); await rm(stagingRoot, { recursive: true, force: true }); });
  const stageArtifact = async (prepare: (folder: string, artifact: string) => Promise<string | undefined>): Promise<PackageStageView> => {
    await sweep(); if (preparing + stages.size >= MAX_STAGES) throw new DashboardError(409, "staging_full", "Discard a staged package before importing or exporting another");
    preparing++; const id = randomUUID(), folder = join(stagingRoot, id), artifact = join(folder, "package.rawpkg");
    try {
      if (context.signal.aborted) throw new DashboardError(503, "closing", "Dashboard is stopping");
      await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(stagingRoot, 0o700);
      const sourceDirectory = await prepare(folder, artifact);
      const report = await inspectPackage(artifact), { manifest } = await validatePackageArchive(artifact);
      const view: PackageStageView = { id, report, inputs: { ...(manifest.inputs ?? { type: "object", properties: {} }) },
        bytes: (await stat(artifact)).size, sha256: await hash(artifact), canLink: !!sourceDirectory, expiresAt: new Date(Date.now() + STAGE_TTL_MS).toISOString() };
      if (context.signal.aborted) throw new DashboardError(503, "closing", "Dashboard is stopping");
      stages.set(id, { view, folder, artifact, ...(sourceDirectory ? { sourceDirectory } : {}) }); return view;
    } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
    finally { preparing--; }
  };
  const getStage = async (id: string) => { await sweep(); const stage = stages.get(id); if (!stage) throw new DashboardError(404, "not_found", "Staged package expired or was discarded; inspect it again"); return stage; };
  const detail = async (alias: string): Promise<PackageView> => {
    const entry = listInstalledPackages(options)[alias]; if (!entry) throw new DashboardError(404, "not_found", "Package alias not found");
    try {
      // Passive linked inspection reads authored files directly, without creating a runtime snapshot.
      const loaded = entry.source.kind === "link" ? await loadPackageManifest(entry.source.path) : await resolveInstalledPackage({ ...options, alias });
      return { alias, entry, report: await inspectPackage(loaded.root), inputs: { ...(loaded.manifest.inputs ?? { type: "object", properties: {} }) }, usedBy: packageReferences(options, alias) };
    } catch (error) { return { alias, entry, diagnostic: error instanceof Error ? error.message : String(error) }; }
  };
  const route: DashboardRoute = async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname, method = request.method;
    if (!/^\/api\/packages(?:\/|$)/.test(path)) return false;
    const work = managementAction(async () => {
      const send = (value: unknown, status = 200) => { context.json(response, status, value); return true; };
      if (path === "/api/packages/stages" && method === "GET") { await sweep(); return send([...stages.values()].map(stage => stage.view)); }
      if (path === "/api/packages" && method === "GET") return send(await Promise.all(Object.keys(listInstalledPackages(options)).map(detail)));
      if (path === "/api/packages/inspect" && method === "POST") {
        const body = await context.readJson(request), source = await realpath(resolve(context.cwd, textField(body.path, "path", 8192)));
        return send(await stageArtifact(async (_folder, artifact) => {
          const info = await stat(source);
          if (info.isDirectory()) { await packPackage(source, artifact); return source; }
          if (!info.isFile() || info.size > MAX_PACKAGE_ARCHIVE_BYTES) throw new DashboardError(413, "body_too_large", "Package archive exceeds 128 MiB or is not a file");
          await copyFile(source, artifact); await chmod(artifact, 0o600); return undefined;
        }), 201);
      }
      if (path === "/api/packages/upload" && method === "POST") {
        if (request.headers["content-type"] !== "application/octet-stream") throw new DashboardError(400, "content_type", "Upload archive bytes as application/octet-stream");
        const length = request.headers["content-length"];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_PACKAGE_ARCHIVE_BYTES)) { request.resume(); throw new DashboardError(413, "body_too_large", "Package archive exceeds 128 MiB"); }
        return send(await stageArtifact(async (_folder, artifact) => { await writeUpload(request, artifact, context.signal); return undefined; }), 201);
      }
      if (path === "/api/packages/install" && method === "POST") {
        const body = await context.readJson(request), stage = await getStage(textField(body.stageId, "stageId")), alias = textField(body.alias, "alias");
        if (body.action === "link") {
          if (!stage.sourceDirectory) throw new DashboardError(422, "invalid_input", "Link requires a local source directory");
          await linkPackage({ ...options, source: stage.sourceDirectory, alias });
        } else if (body.action === "install" || body.action === "update") await (body.action === "install" ? installPackage : updatePackage)({ ...options, source: stage.artifact, alias });
        else throw new DashboardError(400, "invalid_input", "action must be install, update or link");
        return send(await detail(alias));
      }
      const stageRoute = /^\/api\/packages\/stages\/([^/]+)(\/download)?$/.exec(path);
      if (stageRoute) {
        const stage = await getStage(stageRoute[1]!);
        if (method === "DELETE" && !stageRoute[2]) { await discard(stage.view.id); return send({ discarded: true }); }
        if (method === "GET" && stageRoute[2]) {
          response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="raw-package-${stage.view.sha256.slice(0, 12)}.rawpkg"`, "Content-Length": stage.view.bytes });
          await pipeline(createReadStream(stage.artifact), response, { signal: context.signal }); return true;
        }
      }
      if (path === "/api/packages/export" && method === "POST") {
        const body = await context.readJson(request), current = await readManagedConfig(options); assertRevision(revisionField(body), current);
        const agentName = textField(body.agent, "agent"), name = textField(body.name, "name"), version = textField(body.version, "version");
        if (body.includeLiterals !== undefined && typeof body.includeLiterals !== "boolean") throw new DashboardError(400, "invalid_input", "includeLiterals must be boolean");
        if (body.includeFiles !== undefined && (!Array.isArray(body.includeFiles) || body.includeFiles.some(v => typeof v !== "string"))) throw new DashboardError(400, "invalid_input", "includeFiles must be a list of paths");
        return send(await stageArtifact(async (folder, artifact) => {
          const exported = await exportAgentPackage({ ...options, agentName, name, version, out: join(folder, "source"), globalConfigRoot: dirname(canonicalConfigPath(options)),
            includeLiterals: body.includeLiterals === true, includeFiles: (body.includeFiles ?? []) as string[] });
          assertRevision(current.revision, await readManagedConfig(options)); await packPackage(exported.root, artifact); return undefined;
        }), 201);
      }
      const pkg = /^\/api\/packages\/([^/]+)(?:\/(agent|component|fork))?$/.exec(path);
      if (pkg) {
        const alias = decodeURIComponent(pkg[1]!);
        if (method === "GET" && !pkg[2]) return send(await detail(alias));
        if (method === "DELETE" && !pkg[2]) {
          try { await removePackage({ ...options, alias }); } catch (error) { if (/is used by/.test(String(error))) throw new DashboardError(409, "in_use", (error as Error).message); throw error; }
          return send({ removed: true });
        }
        if (method === "POST" && pkg[2]) {
          const body = await context.readJson(request);
          if (pkg[2] === "fork") return send({ path: await forkPackage({ ...options, alias, out: resolve(context.cwd, textField(body.out, "out", 8192)) }) });
          const exportName = textField(body.exportName, "exportName"), inputs = body.inputs === undefined ? {} : managementInput(body.inputs, "inputs");
          if (pkg[2] === "agent") {
            const result = await addPackageAgent({ ...options, expectedRevision: revisionField(body), name: textField(body.name, "name"), from: `pkg/${alias}/agents/${exportName}`, model: textField(body.model, "model"), inputs });
            return send({ ...result, revision: (await readManagedConfig(options)).revision });
          }
          if (!componentKinds.includes(body.kind as typeof componentKinds[number]) || body.kind === "agents") throw new DashboardError(400, "invalid_input", "Choose a component kind");
          const result = await attachPackageComponent({ ...options, expectedRevision: revisionField(body) }, { from: `pkg/${alias}/${body.kind as string}/${exportName}`, inputs,
            ...(body.agent ? { agent: textField(body.agent, "agent") } : {}), ...(body.name ? { name: textField(body.name, "name") } : {}), ...(body.as ? { as: textField(body.as, "as") } : {}) });
          return send({ revision: result.revision });
        }
      }
      return false;
    });
    pending.add(work); try { return await work; } finally { pending.delete(work); }
  };
  return [route];
}
