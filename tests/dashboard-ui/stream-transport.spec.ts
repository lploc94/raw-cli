import { test, expect, openChat } from "./fixtures.js";

for (const remote of [false, true])
  test(`chat events use ${remote ? "POST" : "GET"} when the dashboard is ${remote ? "remote" : "local"}`, async ({ page, raw }) => {
    if (remote) raw.server.allowPublicOrigin("https://x.trycloudflare.com");
    const methods: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/events")) methods.push(request.method()); });
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("Show the answer");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set([remote ? "POST" : "GET"]));
  });
