import { build } from "esbuild";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const flow = "flowchart LR\n  Start --> Finish";
const sequence = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Ready";
const fence = (source: string) => `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
const text = (content: string) => ({ frames: [openAiFrame({ content }, "stop"), openAiDone] });
const call = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "diagrams", type: "function", function: { name: "diagrams", arguments: "{}" } }] }, "tool_calls"), openAiDone] };
async function send(page: Page) {
  await page.getByRole("textbox", { name: "Message" }).fill("show diagrams");
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
function plugin(raw: { env: NodeJS.ProcessEnv }, panels: object[], body: string) {
  const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "diagrams");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "diagrams", version: "1.0.0", name: "diagrams", description: "Diagrams", entry: "./index.mjs",
    input_schema: { type: "object", properties: {}, additionalProperties: false }, panels }));
  writeFileSync(join(folder, "index.mjs"), `export async function handler(args,context){${body};return {content:[{type:'text',text:'Diagrams ready'}]};}`);
}
const update = (panel: string, source: string, title: string) => `await context.panels.update(${JSON.stringify(panel)},{op:'replace',document:{blocks:[{id:'diagram',kind:'mermaid',title:${JSON.stringify(title)},source:${JSON.stringify(source)}}]}})`;

test.describe("shared Mermaid placements", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/diagrams"] } }, responses: [call, text("Assistant diagrams" + fence(flow) + fence(sequence))] } });
  test("Markdown and chat/sidebar blocks render actual accessible SVG under served CSP", async ({ page, raw }, testInfo) => {
    test.setTimeout(60000);
    plugin(raw, [{ id: "chat", title: "Chat diagram", placement: "chat" }, { id: "side", title: "Sidebar diagram", placement: "sidebar", open: "never" }],
      ["chat", "side"].map(panel => `await context.panels.update(${JSON.stringify(panel)},${JSON.stringify({op:"replace",document:{blocks:[{id:"flow",kind:"mermaid",title:"Flowchart",source:flow},{id:"sequence",kind:"mermaid",title:"Sequence",source:sequence}]}})})`).join(";"));
    const documentResponse = await page.goto(raw.server.launchUrl);
    const csp = documentResponse?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await send(page);
    const chat = page.locator('.inline-tool-view .mermaid-diagram').filter({ has: page.locator('svg[aria-label="Sequence"]') });
    await expect(page.locator('.inline-tool-view .mermaid-diagram svg[aria-label="Flowchart"]')).toBeVisible();
    await expect(chat.locator('.mermaid-viewport svg[role="img"]')).toBeVisible();
    await expect(chat.locator(".mermaid-viewport svg")).toContainText("Alice");
    const assistantDiagrams = page.getByTestId("assistant-message").locator(".mermaid-diagram");
    await expect(assistantDiagrams.nth(1).locator("svg[role=img]")).toContainText("Alice");
    const assistant = assistantDiagrams.first();
    await expect(assistant.locator('.mermaid-viewport svg[role="img"]')).toBeVisible();
    await expect(assistant.locator(".mermaid-viewport svg")).toContainText("Finish");
    await assistant.getByRole("button", { name: "Show source", exact: true }).click();
    await expect(assistant.locator(".mermaid-source")).toContainText(flow);
    await expect(assistant.getByRole("button", { name: "Copy Mermaid source", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("Unrelated draft must preserve source selection");
    await expect(assistant.getByRole("button", { name: "Show diagram", exact: true })).toBeVisible();
    await assistant.getByRole("button", { name: "Show diagram", exact: true }).click();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    const sidebar = page.locator('[data-panel="local/diagrams#side"]');
    await sidebar.locator(".panel-toggle").click();
    await expect(sidebar.locator('.mermaid-viewport svg[role="img"]')).toHaveCount(2);
    await expect(sidebar.locator('svg[aria-label="Flowchart"]')).toContainText("Start");
    await expect(sidebar.locator('svg[aria-label="Sequence"]')).toContainText("Alice");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(sidebar.locator('.mermaid-viewport svg[role="img"]').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`mermaid-${theme}.png`), fullPage: true });
    }
  });
});

const hostile = [
  "%%{init: {'securityLevel':'loose','flowchart':{'htmlLabels':true}}}%%\nflowchart LR\nA-->B",
  "---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B",
  'flowchart LR\nA[Click]\nclick A "https://diagram-attacker.invalid/navigation"',
  'flowchart LR\nA["<img src=https://diagram-attacker.invalid/image onerror=alert(1)>"]',
  'flowchart LR\nA["<script>window.diagramAttack=1</script>"]',
  "flowchart LR\nA-->B\nstyle A fill:url(https://diagram-attacker.invalid/style)",
  'flowchart LR\nA[Click]\nclick A "/diagram-attacker-navigation"',
  'flowchart LR\nA["<img src=/diagram-attacker-image onerror=alert(1)>"]',
  "flowchart LR\nA-->B\nstyle A fill:url(/diagram-attacker-style)",
  "not a diagram definition ???",
  "flowchart LR\n" + "A-->B\n".repeat(110),
  "flowchart LR\nA[" + "x".repeat(17000) + "]",
];
test.describe("Mermaid security and fallback", () => {
  test.use({ scenario: { responses: [text(hostile.map(fence).join("\n")), text("The page still works.")] } });
  test("hostile, invalid and oversized sources stay readable without script, resource requests or navigation", async ({ page, raw }) => {
    const external: string[] = [];
    const pageErrors: string[] = [];
    const dialogs: string[] = [];
    page.on("request", request => { if (request.url().includes("/diagram-attacker") || (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(raw.server.launchUrl).origin)) external.push(request.url()); });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await openChat(page, raw);
    const url = page.url();
    await send(page);
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    const diagrams = page.locator(".mermaid-diagram");
    await expect(diagrams).toHaveCount(hostile.length);
    for (let index = 0; index < hostile.length; index++) {
      await expect(diagrams.nth(index).locator("p[role=status]")).toBeVisible();
      await expect(diagrams.nth(index).locator(".mermaid-source")).toBeVisible();
    }
    await expect(diagrams.locator(".mermaid-viewport svg")).toHaveCount(0);
    expect(external).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { diagramAttack?: number }).diagramAttack)).toBeUndefined();
    expect(page.url()).toBe(url);
    await page.getByRole("textbox", { name: "Message" }).fill("continue");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("The page still works.");
  });
});

test.describe("incomplete streaming fence", () => {
  test.use({ scenario: { responses: [{ frames: [openAiFrame({ content: "Partial\n\n```mermaid\nflowchart LR\nA-->B" })], keepOpen: true }] } });
  test("an unclosed streaming fence stays source without starting a render", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page);
    await expect(page.locator(".markdown pre code")).toContainText("flowchart LR");
    await expect(page.locator(".mermaid-viewport svg")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  });
});

test.describe("async Mermaid updates", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/diagrams"] } }, responses: [call, text("Updated diagram.")] } });
  test("a pending renderer cannot overwrite the newest tool source", async ({ page, raw }) => {
    plugin(raw, [{ id: "side", title: "Sidebar diagram", placement: "sidebar", open: "first_update" }],
      update("side", "flowchart LR\nOldStart-->OldEnd", "Latest") + ";await new Promise(resolve=>setTimeout(resolve,500));" + update("side", "flowchart LR\nNewestStart-->NewestEnd", "Latest"));
    // Delay lazy renderer assets while live panel updates replace the first source.
    await page.route("**/assets/*", async route => {
      if (/mermaid/i.test(route.request().url())) await new Promise(resolve => setTimeout(resolve, 1200));
      await route.continue();
    });
    await openChat(page, raw);
    await send(page);
    const figure = page.locator('[data-panel="local/diagrams#side"] .mermaid-diagram');
    await expect(figure.locator(".mermaid-viewport svg")).toContainText("NewestEnd");
    await expect(figure.locator(".mermaid-viewport svg")).not.toContainText("OldEnd");
    await figure.getByRole("button", { name: "Show source", exact: true }).click();
    await expect(figure.locator(".mermaid-source")).toContainText("NewestStart");
    await page.reload();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(figure.locator(".mermaid-viewport svg")).toContainText("NewestEnd");
  });
});

test("the production SVG sanitizer removes executable/resource SVG while preserving safe geometry and local markers", async ({ page, raw }) => {
  // Bundle the actual production sanitizer for this browser fixture; no production endpoint or global test hook.
  const bundle = await build({ stdin: { contents: 'export { sanitizeDiagram } from "./web/src/diagrams/sanitize.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "browser", format: "esm", write: false });
  await page.route("**/test-mermaid-sanitizer.js", route => route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text }));
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/diagram-attacker")) requests.push(request.url()); });
  await openChat(page, raw);
  const result = await page.evaluate(async () => {
    const moduleUrl = "/test-mermaid-sanitizer.js";
    const { sanitizeDiagram } = await import(moduleUrl);
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="window.diagramAttack=1" viewBox="0 0 100 100">
      <script>window.diagramAttack=1</script><style>@import '/diagram-attacker-css';</style>
      <foreignObject><img src="/diagram-attacker-html" onerror="window.diagramAttack=1" /></foreignObject>
      <image href="/diagram-attacker-image"/><use xlink:href="/diagram-attacker-use#shape"/>
      <a href="/diagram-attacker-navigation"><text x="1" y="2" onclick="window.diagramAttack=1">Safe label</text></a>
      <animate attributeName="href" to="/diagram-attacker-animation"/><set attributeName="onload" to="window.diagramAttack=1"/>
      <defs><marker id="safe-marker" markerWidth="5" markerHeight="5"><path d="M0 0L5 5"/></marker></defs>
      <path id="safe-path" d="M0 0L10 10" marker-end="url(#safe-marker)" />
      <path id="remote-marker" d="M0 0L20 20" marker-end="url(/diagram-attacker-marker#m)" />
      <rect id="safe-rect" width="10" height="10" fill="url(/diagram-attacker-fill)" style="background:url(/diagram-attacker-background)"/>
    </svg>`;
    const safe = sanitizeDiagram(dirty, 'Safe "diagram"');
    const container = document.createElement("div");
    container.id = "sanitized-diagram-fixture";
    container.innerHTML = safe;
    document.body.append(container);
    const svg = container.querySelector("svg")!;
    const forbidden = container.querySelectorAll("script,style,foreignObject,image,use,a,animate,set,img").length;
    const badAttributes = [...container.querySelectorAll("*")].flatMap(node => [...node.attributes].filter(attribute => /^(?:on|style$|href$|xlink:href$|src$)/i.test(attribute.name)).map(attribute => attribute.name));
    return { forbidden, badAttributes, role: svg.getAttribute("role"), label: svg.getAttribute("aria-label"),
      marker: container.querySelector("#safe-path")?.getAttribute("marker-end"), remoteMarker: container.querySelector("#remote-marker")?.getAttribute("marker-end"),
      width: container.querySelector("#safe-rect")?.getAttribute("width"), safe, attack: (window as unknown as { diagramAttack?: number }).diagramAttack };
  });
  expect(result.forbidden).toBe(0);
  expect(result.badAttributes).toEqual([]);
  expect(result.role).toBe("img");
  expect(result.label).toBe('Safe "diagram"');
  expect(result.marker).toBe("url(#safe-marker)");
  expect(result.remoteMarker).toBeNull();
  expect(result.width).toBe("10");
  expect(result.safe).not.toContain("/diagram-attacker");
  expect(result.attack).toBeUndefined();
  await page.waitForTimeout(100);
  expect(requests).toEqual([]);
});

test.describe("entity-encoded labels through the real renderer", () => {
  test.use({ scenario: { responses: [text(fence('flowchart LR\nA["&lt;img src=&quot;/diagram-attacker-encoded&quot; onerror=&quot;window.diagramAttack=1&quot;&gt;"]-->B'))] } });
  test("HTML-looking encoded labels do not create resource nodes in Mermaid staging or final SVG", async ({ page, raw }) => {
    const requests: string[] = [];
    page.on("request", request => { if (request.url().includes("/diagram-attacker")) requests.push(request.url()); });
    await openChat(page, raw);
    await send(page);
    await expect(page.locator(".mermaid-viewport svg[role=img]")).toBeVisible();
    await expect(page.locator(".mermaid-diagram img, .mermaid-diagram image, .mermaid-diagram foreignObject")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { diagramAttack?: number }).diagramAttack)).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
