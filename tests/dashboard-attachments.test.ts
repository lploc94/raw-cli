import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { imageBlock, jpegFixture, makePng, makePngOfSize } from "./fixtures/images.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

const reply = (text = "ok") => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const png = makePng();
type Fixture = Awaited<ReturnType<typeof dashboardFixture>>;

const upload = (f: Fixture, sessionId: string, bytes: Buffer, mime: string, name = "shot.png") =>
  fetch(`${f.server.url}/api/sessions/${sessionId}/attachments`, { method: "POST",
    headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": mime, "X-Raw-Filename": encodeURIComponent(name) }, body: new Uint8Array(bytes) });
const stageOk = async (f: Fixture, sessionId: string, bytes = png, mime = "image/png", name = "shot.png") => {
  const response = await upload(f, sessionId, bytes, mime, name);
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as { id: string; kind: string; name: string; mimeType: string; byteSize: number };
};
const session = (f: Fixture) => f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
const turn = async (f: Fixture, sessionId: string, body: Record<string, unknown>) => {
  const response = await f.api(`/sessions/${sessionId}/operations`, "POST", { kind: "turn", agent: "raw", ...body });
  return { status: response.status, body: await response.json() as SessionOperation & { error?: { code: string } } };
};
const lastBody = (f: Fixture) => JSON.stringify(f.provider.requests.at(-1)?.body);

test("uploads validate type, structure, size and staging caps without touching earlier chips", async () => {
  const f = await dashboardFixture({ model: { vision: true } });
  try {
    const { id } = await session(f);
    const a = await stageOk(f, id);
    assert.deepEqual([a.kind, a.mimeType, a.name, a.byteSize], ["image", "image/png", "shot.png", png.length]);
    await stageOk(f, id, jpegFixture(), "image/jpeg", "photo.jpg");
    assert.equal((await upload(f, id, Buffer.from("GIF89a...."), "image/gif")).status, 415);
    assert.equal((await upload(f, id, Buffer.from("not really a png"), "image/png")).status, 400);
    assert.equal((await upload(f, id, jpegFixture(), "image/png")).status, 400);
    assert.equal((await upload(f, id, Buffer.alloc(0), "image/png")).status, 400);
    assert.equal((await upload(f, id, Buffer.alloc(8 * 1024 * 1024 + 1, 1), "image/png")).status, 413);
    const big = makePngOfSize(6 * 1024 * 1024);
    await stageOk(f, id, big); // 3 files staged: ~6 MiB + small
    await stageOk(f, id, big);
    const over = await upload(f, id, big, "image/png");
    assert.equal(over.status, 413);
    assert.equal(((await over.json()) as { error: { code: string } }).error.code, "attachments_too_large");
    assert.equal(f.server.context.attachments!.size(), 4);
    const removed = await f.json<{ removed: boolean }>(`/sessions/${id}/attachments/${a.id}`, "DELETE");
    assert.equal(removed.removed, true);
    assert.equal((await f.json<{ removed: boolean }>(`/sessions/${id}/attachments/${a.id}`, "DELETE")).removed, false);
    // Staging limits never block a text-only send.
    f.provider.requests.length = 0;
    const sent = await turn(f, id, { clientRequestId: "text-only", input: "hello" });
    assert.equal(sent.status, 202);
    assert.equal((await f.wait(sent.body.id)).state, "completed");
    const cap = await session(f);
    for (let i = 0; i < 8; i++) await stageOk(f, cap.id, makePng(8 + i, 8));
    assert.equal((await upload(f, cap.id, makePng(20, 20), "image/png")).status, 413);
  } finally { await f.close(); }
});

test("an uploaded image reaches a vision provider byte-for-byte, is consumed once and never stored on the operation row", async () => {
  const f = await dashboardFixture({ model: { vision: true }, responses: [reply(), reply(), reply()] });
  try {
    const { id } = await session(f);
    const staged = await stageOk(f, id, png, "image/png", "screen.png");
    const first = await turn(f, id, { clientRequestId: "one", input: "what is this?", attachments: [staged.id] });
    assert.equal(first.status, 202);
    const done = await f.wait(first.body.id);
    assert.equal(done.state, "completed");
    const messages = (f.provider.requests[0]?.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const user = messages.find((message) => message.role === "user")!.content as Array<Record<string, any>>;
    assert.deepEqual(user[0], { type: "text", text: "what is this?" });
    assert.equal(user[1]?.image_url.url, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(f.server.context.attachments!.size(), 0);
    const row = JSON.stringify(f.server.context.store!.getOperation(first.body.id));
    assert.ok(!row.includes(png.toString("base64").slice(0, 80)));
    assert.equal(JSON.parse(row).input, "what is this?");
    // A replayed request id returns the same receipt and leaves newly staged items untouched.
    const another = await stageOk(f, id, jpegFixture(), "image/jpeg", "b.jpg");
    const replay = await turn(f, id, { clientRequestId: "one", input: "what is this?", attachments: [another.id] });
    assert.equal(replay.body.id, first.body.id);
    assert.equal(f.server.context.attachments!.size(), 1);
    assert.equal(f.provider.requests.length, 1);
    // Unknown or foreign ids are refused before the operation is accepted.
    const other = await session(f);
    const foreign = await turn(f, other.id, { clientRequestId: "foreign", input: "x", attachments: [another.id] });
    assert.equal(foreign.status, 422);
    assert.equal(foreign.body.error?.code, "unknown_attachment");
    assert.equal(f.server.context.store!.findOperation(other.id, "foreign"), undefined);
    assert.equal(f.server.context.attachments!.size(), 1);
  } finally { await f.close(); }
});

test("concurrent duplicate submits consume only the accepted request's attachments and repeated ids are refused", async () => {
  const f = await dashboardFixture({ model: { vision: true }, responses: [reply(), reply()] });
  try {
    writeFileSync(join(f.root, "notes.txt"), "n"); writeFileSync(join(f.root, "..notes.txt"), "dotted");
    const { id } = await session(f);
    const a = await stageOk(f, id); const b = await stageOk(f, id, jpegFixture(), "image/jpeg", "b.jpg");
    const [x, y] = await Promise.all([
      turn(f, id, { clientRequestId: "race", input: "go", attachments: [a.id], files: ["notes.txt"] }),
      turn(f, id, { clientRequestId: "race", input: "go", attachments: [b.id], files: ["notes.txt"] })]);
    assert.equal(x.body.id, y.body.id);
    assert.equal((await f.wait(x.body.id)).state, "completed");
    assert.equal(f.server.context.attachments!.size(), 1, "exactly one staged item is consumed");
    const c = await stageOk(f, id);
    const repeated = await turn(f, id, { clientRequestId: "repeat", input: "x", attachments: [c.id, c.id] });
    assert.equal(repeated.status, 400);
    assert.equal(f.server.context.store!.findOperation(id, "repeat"), undefined);
    // A file whose name merely starts with two dots is a valid in-workspace file.
    const dotted = await turn(f, id, { clientRequestId: "dots", input: "read", files: ["..notes.txt"] });
    assert.equal(dotted.status, 202);
    assert.equal((await f.wait(dotted.body.id)).state, "completed");
  } finally { await f.close(); }
});

test("unsupported oversize uploads get 415 and oversize supported uploads get a specific 413 code", async () => {
  const f = await dashboardFixture();
  try {
    const { id } = await session(f);
    assert.equal((await upload(f, id, Buffer.alloc(9 * 1024 * 1024, 1), "application/pdf")).status, 415);
    const big = await upload(f, id, Buffer.alloc(9 * 1024 * 1024, 1), "image/png");
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as { error: { code: string } }).error.code, "attachment_too_large");
  } finally { await f.close(); }
});

test("non-vision agents and agent switches degrade to placeholders instead of failing", async () => {
  const f = await dashboardFixture({ responses: [reply(), reply(), reply()] });
  try {
    const cfg = f.config as any;
    cfg.models.eyes = { ...cfg.models.fixture, vision: true };
    cfg.agents.eyes = { ...cfg.agents.raw, model: "eyes" };
    writeFileSync(f.configPath, JSON.stringify(cfg));
    const { id } = await session(f);
    const staged = await stageOk(f, id, png, "image/png", "screen.png");
    const blind = await turn(f, id, { clientRequestId: "blind", input: "describe", attachments: [staged.id] });
    assert.equal(blind.status, 202);
    assert.equal((await f.wait(blind.body.id)).state, "completed");
    const first = lastBody(f);
    assert.match(first, /Image omitted: image\/png/);
    assert.ok(!first.includes("image_url") && !first.includes(png.toString("base64").slice(0, 60)));
    // Switching to a vision agent sends the stored image natively again.
    const seeing = await turn(f, id, { clientRequestId: "seeing", agent: "eyes", input: "and now?" });
    assert.equal((await f.wait(seeing.body.id)).state, "completed");
    assert.ok(lastBody(f).includes(png.toString("base64")));
    // Switching back to the non-vision agent still works and degrades again.
    const back = await turn(f, id, { clientRequestId: "back", input: "once more" });
    assert.equal((await f.wait(back.body.id)).state, "completed");
    assert.match(lastBody(f), /Image omitted/);
    assert.ok(!lastBody(f).includes(png.toString("base64").slice(0, 60)));
  } finally { await f.close(); }
});

test("workspace file references stay inside the workspace and reach the model as resource links", async () => {
  const f = await dashboardFixture({ responses: [reply()] });
  try {
    mkdirSync(join(f.root, "src"), { recursive: true }); mkdirSync(join(f.root, "elsewhere-target"), { recursive: true });
    writeFileSync(join(f.root, "src", "app.ts"), "export {}\n");
    const outside = join(f.root, "..", `outside-${Date.now()}.txt`); writeFileSync(outside, "secret");
    symlinkSync(outside, join(f.root, "src", "leak.txt"));
    const { id } = await session(f);
    for (const [index, file] of ["../x", "/etc/passwd", "src/../../etc/passwd", "src/leak.txt", "src", "missing.ts", "src/\0bad"].entries()) {
      const refused = await turn(f, id, { clientRequestId: `bad-${index}`, input: "read", files: [file] });
      assert.equal(refused.status, 422, file);
      assert.equal(refused.body.error?.code, "invalid_file", file);
    }
    assert.equal(f.provider.requests.length, 0);
    const ok = await turn(f, id, { clientRequestId: "good", input: "read it", files: ["src/app.ts"] });
    assert.equal(ok.status, 202);
    assert.equal((await f.wait(ok.body.id)).state, "completed");
    assert.match(lastBody(f), /Resource link/);
    assert.match(lastBody(f), /file:\/\/[^"\\]*src\/app\.ts/);
  } finally { await f.close(); }
});

test("file search ranks, limits, ignores noise and never follows symlinks", async () => {
  const f = await dashboardFixture();
  try {
    const ws = join(f.root, "ws");
    for (const dir of ["src", "src/deep", "node_modules/pkg", ".git", "docs"]) mkdirSync(join(ws, dir), { recursive: true });
    for (const file of ["src/app.ts", "src/deep/application.ts", "docs/notes-app.md", "README.md", "node_modules/pkg/app.js", ".git/app", ".hidden"]) writeFileSync(join(ws, file), "x");
    symlinkSync(join(ws, "src"), join(ws, "linked"));
    const { id } = await f.json<SessionSummary>("/sessions", "POST", { cwd: ws });
    const search = (query: string) => f.json<{ items: Array<{ path: string; name: string }> }>(`/sessions/${id}/files?${query}`).then((result) => result.items.map((item) => item.path));
    assert.deepEqual(await search("q=app"), ["src/app.ts", "src/deep/application.ts", "docs/notes-app.md"]);
    assert.deepEqual(await search("q=nomatchatall"), []);
    assert.deepEqual(await search("q=app&limit=1"), ["src/app.ts"]);
    assert.deepEqual(await search("q=sa"), ["src/app.ts", "docs/notes-app.md", "src/deep/application.ts"]);
    const all = await search("");
    assert.ok(all.includes("README.md") && !all.some((path) => path.startsWith("node_modules") || path.startsWith(".git") || path.startsWith("linked") || path.startsWith(".hidden")));
    assert.equal(all[0], "README.md");
    for (const limit of ["0", "51", "x"]) assert.equal((await f.api(`/sessions/${id}/files?limit=${limit}`)).status, 400);
  } finally { await f.close(); }
});

test("composer metadata reports vision, warnings and attachment kinds without credentials", async () => {
  const seeing = await dashboardFixture({ model: { vision: true } });
  const blind = await dashboardFixture();
  try {
    const eyes = await seeing.json<any>("/agents/raw/composer");
    assert.equal(eyes.vision, true);
    assert.deepEqual(eyes.attachmentKinds, [{ id: "image", accept: ["image/png", "image/jpeg"], maxBytes: 8 * 1024 * 1024, enabled: true }]);
    const plain = await blind.json<any>("/agents/raw/composer");
    assert.equal(plain.vision, false);
    assert.equal(plain.attachmentKinds[0].enabled, true);
    assert.match(plain.attachmentKinds[0].warning, /placeholder/);
    assert.deepEqual(plain.skills, []);
    assert.equal((await blind.api("/agents/nope/composer")).status, 404);
    const cfg = blind.config as any;
    cfg.agents.raw.tools = { use: ["builtin/list_skills", "builtin/load_skill"] };
    cfg.agents.raw.skills = { use: ["builtin/create_agent", "local/missing_one"] };
    writeFileSync(blind.configPath, JSON.stringify(cfg));
    const withSkills = await blind.json<any>("/agents/raw/composer");
    assert.equal(withSkills.skills[0].name, "create-agent");
    assert.ok(withSkills.skills[0].description.length > 10);
    assert.equal(withSkills.skills.length, 1, "a missing skill is skipped without hiding the others");
  } finally { await seeing.close(); await blind.close(); }
});

test("staging and consumption are kind-agnostic: a newly registered kind needs no route changes", async () => {
  const f = await dashboardFixture({ responses: [reply()] });
  try {
    f.server.context.attachments!.kinds.register({ id: "note", mimeTypes: ["text/x-note"], maxBytes: 1024,
      validate: () => {}, toBlock: (item) => ({ type: "text", text: `NOTE:${item.bytes.toString("utf8")}` }),
      fromBlock: () => undefined });
    const { id } = await session(f);
    const staged = await stageOk(f, id, Buffer.from("remember milk"), "text/x-note", "n.txt");
    assert.equal(staged.kind, "note");
    assert.equal((await upload(f, id, Buffer.alloc(2048, 65), "text/x-note")).status, 413);
    const sent = await turn(f, id, { clientRequestId: "note", input: "use the note", attachments: [staged.id] });
    assert.equal((await f.wait(sent.body.id)).state, "completed");
    assert.match(lastBody(f), /NOTE:remember milk/);
    const meta = await f.json<any>("/agents/raw/composer");
    assert.ok(meta.attachmentKinds.some((kind: any) => kind.id === "note"));
  } finally { await f.close(); }
});

test("closing the dashboard drops every staged attachment", async () => {
  const f = await dashboardFixture();
  const { id } = await session(f);
  await stageOk(f, id);
  const staging = f.server.context.attachments!;
  assert.equal(staging.size(), 1);
  await f.close();
  assert.equal(staging.size(), 0);
});
