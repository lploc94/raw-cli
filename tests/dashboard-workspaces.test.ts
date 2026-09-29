import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionSummary } from "../src/sessions/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

interface Item { cwd: string; updatedAt: number; sessions: number; running: number; exists: boolean }
interface Listing { items: Item[]; home: string; current: string }
interface Browse { path: string; parent: string | null; home: string; entries: Array<{ name: string; path: string; symlink?: boolean }>; truncated: boolean }
const reply = { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] };

function tempDir(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name); out.push(path); if (entry.isDirectory()) walk(path); } };
  walk(root); return out;
}
async function error(f: Awaited<ReturnType<typeof dashboardFixture>>, path: string): Promise<{ status: number; code: string; text: string }> {
  const response = await f.api(path); const text = await response.text();
  return { status: response.status, code: (JSON.parse(text) as { error: { code: string } }).error.code, text };
}

test("the workspace list reports chat counts, running operations and whether each directory still exists", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  const a = tempDir("raw-ws-a-"); const b = tempDir("raw-ws-b-"); const gone = tempDir("raw-ws-gone-");
  try {
    const create = (cwd: string) => f.json<SessionSummary>("/sessions", "POST", { cwd });
    const a1 = await create(a); await create(a); await create(b); await create(gone);
    const configBefore = readFileSync(f.configPath);
    let listing = await f.json<Listing>("/workspaces");
    const byPath = (l: Listing, cwd: string) => l.items.find((item) => item.cwd === cwd)!;
    const root = realpathSync(f.root);
    assert.equal(listing.current, root);
    assert.equal(byPath(listing, root).updatedAt, 0);
    assert.equal(byPath(listing, root).sessions, 0);
    assert.equal(byPath(listing, a).sessions, 2);
    assert.equal(byPath(listing, b).sessions, 1);
    assert.equal(byPath(listing, a).running, 0);
    assert.ok(byPath(listing, a).updatedAt > 0);
    assert.ok(listing.items.every((item) => item.exists === true));
    assert.equal(typeof listing.home, "string");

    rmSync(gone, { recursive: true });
    listing = await f.json<Listing>("/workspaces");
    assert.equal(byPath(listing, gone).exists, false);
    assert.equal(byPath(listing, a).exists, true);

    const op = await f.json<{ id: string }>(`/sessions/${a1.id}/operations`, "POST", { clientRequestId: "run", kind: "turn", agent: "raw", input: "hold" });
    for (let attempt = 0; attempt < 200 && (await f.json<Listing>("/workspaces")).items.find((i) => i.cwd === a)!.running === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    listing = await f.json<Listing>("/workspaces");
    assert.equal(byPath(listing, a).running, 1);
    assert.equal(byPath(listing, b).running, 0);
    await f.json(`/operations/${op.id}/cancel`, "POST", {});
    await f.wait(op.id);
    assert.equal(byPath(await f.json<Listing>("/workspaces"), a).running, 0);

    const db = new DatabaseSync(join(f.root, "state", "raw", "sessions.sqlite"));
    db.prepare("UPDATE sessions SET updated_at = 1 WHERE workspace_id = (SELECT id FROM workspaces WHERE display_path = ?)").run(b);
    db.close();
    listing = await f.json<Listing>("/workspaces");
    assert.equal(listing.items.some((item) => item.cwd === b), false, "expired chats no longer make a workspace recent");
    assert.deepEqual(readFileSync(f.configPath), configBefore, "listing never touches config");
  } finally { await f.close(); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); rmSync(gone, { recursive: true, force: true }); }
});

test("the workspace list names a folder by its canonical path even when a chat stored a symlinked cwd", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  const real = tempDir("raw-ws-real-"); const aliasRoot = tempDir("raw-ws-alias-"); const alias = join(aliasRoot, "link"); symlinkSync(real, alias);
  try {
    const chat = await f.json<SessionSummary>("/sessions", "POST", { cwd: real });
    const db = new DatabaseSync(join(f.root, "state", "raw", "sessions.sqlite"));
    db.prepare("UPDATE workspaces SET display_path = ? WHERE canonical_path = ?").run(alias, real);
    db.close();
    const listing = await f.json<Listing>("/workspaces");
    assert.equal(listing.items.filter((item) => item.cwd === real).length, 1);
    assert.equal(listing.items.some((item) => item.cwd === alias), false);
    assert.equal(listing.items.find((item) => item.cwd === real)!.sessions, 1);
    const op = await f.json<{ id: string }>(`/sessions/${chat.id}/operations`, "POST", { clientRequestId: "run", kind: "turn", agent: "raw", input: "hold" });
    for (let attempt = 0; attempt < 200 && (await f.json<Listing>("/workspaces")).items.find((i) => i.cwd === real)!.running === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await f.json<Listing>("/workspaces")).items.find((item) => item.cwd === real)!.running, 1);
    await f.json(`/operations/${op.id}/cancel`, "POST", {}); await f.wait(op.id);
    const included = await f.json<Listing>(`/workspaces?include=${encodeURIComponent(alias)}`);
    assert.equal(included.items.filter((item) => item.cwd === real).length, 1);
  } finally { await f.close(); rmSync(real, { recursive: true, force: true }); rmSync(aliasRoot, { recursive: true, force: true }); }
});

test("include adds real metadata for paths outside the recent list and validates its input", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  const dirs: string[] = [];
  try {
    const target = tempDir("raw-ws-target-"); dirs.push(target);
    const targetSession = await f.json<SessionSummary>("/sessions", "POST", { cwd: target });
    const db = new DatabaseSync(join(f.root, "state", "raw", "sessions.sqlite"));
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - 86_400_000, targetSession.id);
    db.close();
    for (let index = 0; index < 101; index++) { const dir = tempDir("raw-ws-many-"); dirs.push(dir); await f.json("/sessions", "POST", { cwd: dir }); }
    const plain = await f.json<Listing>("/workspaces");
    assert.equal(plain.items.some((item) => item.cwd === target), false, "displaced beyond the 100-item recent limit");
    const empty = tempDir("raw-ws-empty-"); dirs.push(empty);
    const query = `include=${encodeURIComponent(target)}&include=${encodeURIComponent(empty)}&include=${encodeURIComponent(target)}&include=${encodeURIComponent(join(empty, "nope"))}`;
    const listing = await f.json<Listing>(`/workspaces?${query}`);
    assert.equal(listing.items.filter((item) => item.cwd === target).length, 1, "deduplicated");
    const included = listing.items.find((item) => item.cwd === target)!;
    assert.equal(included.sessions, 1);
    assert.ok(included.updatedAt > 0 && included.updatedAt < Date.now() - 80_000_000);
    assert.equal(included.exists, true);
    const none = listing.items.find((item) => item.cwd === empty)!;
    assert.deepEqual([none.sessions, none.updatedAt, none.running, none.exists], [0, 0, 0, true]);
    assert.equal(listing.items.find((item) => item.cwd === join(empty, "nope"))!.exists, false);
    const run = await f.json<{ id: string }>(`/sessions/${targetSession.id}/operations`, "POST", { clientRequestId: "run", kind: "turn", agent: "raw", input: "hold" });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.json<Listing>(`/workspaces?include=${encodeURIComponent(target)}`)).items.find((i) => i.cwd === target)!.running === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await f.json<Listing>(`/workspaces?include=${encodeURIComponent(target)}`)).items.find((i) => i.cwd === target)!.running, 1);
    await f.json(`/operations/${run.id}/cancel`, "POST", {}); await f.wait(run.id);

    const many = Array.from({ length: 51 }, (_, index) => `include=${encodeURIComponent(join(empty, `p${index}`))}`).join("&");
    assert.deepEqual([(await error(f, `/workspaces?${many}`)).status, (await error(f, `/workspaces?${many}`)).code], [400, "invalid_input"]);
    assert.equal((await error(f, `/workspaces?include=${"x".repeat(4097)}`)).code, "invalid_input");
    assert.equal((await error(f, "/workspaces?include=")).code, "invalid_input");
    const fifty = Array.from({ length: 50 }, (_, index) => `include=${encodeURIComponent(join(empty, `p${index}`))}`).join("&");
    assert.equal((await f.api(`/workspaces?${fifty}`)).status, 200);
  } finally { await f.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
});

test("browse lists only sub-directories with filtering, ordering, parents and errors, and never leaks files", async () => {
  const f = await dashboardFixture({ responses: [reply] });
  const home = tempDir("raw-ws-home-"); const outside = tempDir("raw-ws-outside-");
  try {
    (f.env as Record<string, string | undefined>).HOME = home;
    for (const dir of ["b", "A", "c", ".hidden", "target-dir"]) mkdirSync(join(home, dir));
    mkdirSync(join(home, "b", "inner"));
    writeFileSync(join(home, "secret-file.txt"), "x"); writeFileSync(join(outside, "file-target"), "x");
    symlinkSync(join(home, "target-dir"), join(home, "linked-dir"));
    symlinkSync(join(outside, "file-target"), join(home, "linked-file"));
    symlinkSync(join(home, "does-not-exist"), join(home, "broken-link"));
    const configBefore = readFileSync(f.configPath); const treeBefore = tree(home);

    const root = await f.json<Browse>("/workspaces/browse");
    assert.equal(root.path, home);
    assert.equal(root.home, home);
    assert.deepEqual(root.entries.map((entry) => entry.name), ["A", "b", "c", "linked-dir", "target-dir"]);
    assert.equal(root.entries.find((entry) => entry.name === "linked-dir")!.symlink, true);
    assert.equal(root.entries.find((entry) => entry.name === "A")!.symlink, undefined);
    assert.equal(root.entries.find((entry) => entry.name === "A")!.path, join(root.path, "A"));
    assert.equal(root.truncated, false);
    const raw = await (await f.api("/workspaces/browse")).text();
    for (const leaked of ["secret-file", "linked-file", "broken-link", "file-target", ".txt"]) assert.ok(!raw.includes(leaked), `${leaked} must not appear`);

    assert.ok((await f.json<Browse>("/workspaces/browse?hidden=1")).entries.some((entry) => entry.name === ".hidden"));
    assert.ok((await f.json<Browse>("/workspaces/browse?hidden=true")).entries.some((entry) => entry.name === ".hidden"));
    assert.ok(!(await f.json<Browse>("/workspaces/browse?hidden=0")).entries.some((entry) => entry.name === ".hidden"));
    assert.deepEqual((await f.json<Browse>("/workspaces/browse?q=DIR")).entries.map((entry) => entry.name), ["linked-dir", "target-dir"]);

    const inner = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(join(home, "b"))}`);
    assert.deepEqual(inner.entries.map((entry) => entry.name), ["inner"]);
    assert.equal(inner.parent, root.path);
    assert.deepEqual((await f.json<Browse>("/workspaces/browse?path=~/b")).entries.map((entry) => entry.name), ["inner"]);
    assert.equal((await f.json<Browse>("/workspaces/browse?path=~")).path, root.path);
    let current = root.path; let hops = 0; let parent: string | null = root.parent;
    while (parent !== null) { const page = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(parent)}`); assert.equal(page.path, parent); parent = page.parent; current = page.path; hops++; assert.ok(hops < 64); }
    assert.equal((await f.json<Browse>("/workspaces/browse?path=/")).parent, null);
    assert.ok(current === "/" || current.length > 0);

    const filesOnly = join(home, "b", "inner"); writeFileSync(join(filesOnly, "only-a-file.md"), "x");
    const listing = await (await f.api(`/workspaces/browse?path=${encodeURIComponent(filesOnly)}`)).text();
    assert.deepEqual((JSON.parse(listing) as Browse).entries, []);
    assert.ok(!listing.includes("only-a-file"));

    for (const [path, status, code] of [["relative/dir", 400, "invalid_workspace"], [join(home, "missing"), 400, "invalid_workspace"], [join(home, "secret-file.txt"), 400, "invalid_workspace"]] as const) {
      const failure = await error(f, `/workspaces/browse?path=${encodeURIComponent(path)}`);
      assert.deepEqual([failure.status, failure.code], [status, code], path);
    }
    assert.equal((await error(f, "/workspaces/browse?hidden=maybe")).code, "invalid_input");
    assert.equal((await error(f, `/workspaces/browse?q=${"x".repeat(201)}`)).code, "invalid_input");

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(home, "locked"); mkdirSync(locked); chmodSync(locked, 0);
      try { const failure = await error(f, `/workspaces/browse?path=${encodeURIComponent(locked)}`); assert.deepEqual([failure.status, failure.code], [422, "unreadable_directory"]); }
      finally { chmodSync(locked, 0o755); }
      mkdirSync(join(locked, "child")); chmodSync(locked, 0);
      try { const failure = await error(f, `/workspaces/browse?path=${encodeURIComponent(join(locked, "child"))}`); assert.deepEqual([failure.status, failure.code], [422, "unreadable_directory"], "a path below an unreadable directory"); }
      finally { chmodSync(locked, 0o755); }
      rmSync(locked, { recursive: true });
    }

    assert.deepEqual(readFileSync(f.configPath), configBefore, "browse never touches config");
    assert.deepEqual(tree(home).filter((path) => !path.endsWith("only-a-file.md")), treeBefore, "browse never changes the directory tree");
  } finally { await f.close(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("browse caps a huge directory at 500 entries and says so", async () => {
  const f = await dashboardFixture({ responses: [reply] });
  const big = tempDir("raw-ws-big-");
  try {
    for (let index = 0; index < 501; index++) mkdirSync(join(big, `d${String(index).padStart(3, "0")}`));
    const page = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(big)}`);
    assert.equal(page.entries.length, 500); assert.equal(page.truncated, true);
    assert.equal(page.entries[0]!.name, "d000");
    const narrowed = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(big)}&q=d500`);
    assert.deepEqual(narrowed.entries.map((entry) => entry.name), ["d500"]); assert.equal(narrowed.truncated, false);
    for (let index = 0; index < 500; index++) rmSync(join(big, `d${String(index).padStart(3, "0")}`), { recursive: true });
    const exact = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(big)}`);
    assert.equal(exact.entries.length, 1); assert.equal(exact.truncated, false);
    for (let index = 0; index < 499; index++) mkdirSync(join(big, `e${String(index).padStart(3, "0")}`));
    writeFileSync(join(big, "target-file"), "x"); symlinkSync(join(big, "target-file"), join(big, "zz-file-link"));
    const full = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(big)}`);
    assert.equal(full.entries.length, 500); assert.equal(full.truncated, false, "a trailing symlink to a file is not a 501st directory");
    symlinkSync(join(big, "e000"), join(big, "zz-dir-link"));
    const over = await f.json<Browse>(`/workspaces/browse?path=${encodeURIComponent(big)}`);
    assert.equal(over.entries.length, 500); assert.equal(over.truncated, true);
  } finally { await f.close(); rmSync(big, { recursive: true, force: true }); }
});

test("workspace routes require the dashboard token", async () => {
  const f = await dashboardFixture({ responses: [reply] });
  try {
    for (const path of ["/workspaces", "/workspaces/browse"]) {
      const response = await fetch(`${f.server.url}/api${path}`);
      assert.equal(response.status, 401, path);
    }
  } finally { await f.close(); }
});
